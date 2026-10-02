import { db, isRetryableDbError } from "~/db.server";
import { serialiseError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { parseMoneyToMinor } from "~/lib/money";
import { currentUtcPeriod, evaluateCap, isPlanKey, type PlanKey } from "~/lib/plans";
import { withRetry } from "~/lib/retry.server";

/**
 * Response ingestion and reconciliation.
 *
 * This module implements docs/03 FLOW 1 (duplicate submission), FLOW 2
 * (response before webhook), and FLOW 9 (free cap reached). It is the only
 * place that writes survey_responses.
 */

export type SubmitResult =
  | { outcome: "created"; id: string; isLocked: boolean }
  | { outcome: "duplicate"; id: string; isLocked: boolean };

export type SubmitInput = {
  shopId: string;
  orderId: string;
  channel: string;
  otherText: string | null;
  locale: string | null;
  plan: PlanKey;
};

const MAX_OTHER_LENGTH = 140;

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

async function incrementUsage(shopId: string): Promise<number> {
  const { periodStart, periodEnd } = currentUtcPeriod();

  return retryDb(async () => {
    // upsert-then-increment so the first response of a period creates the row.
    await db.billingUsage.upsert({
      where: { shopId_periodStart: { shopId, periodStart } },
      create: { shopId, periodStart, periodEnd, responsesCount: 0 },
      update: {},
    });

    const updated = await db.billingUsage.update({
      where: { shopId_periodStart: { shopId, periodStart } },
      data: { responsesCount: { increment: 1 } },
      select: { responsesCount: true },
    });

    return updated.responsesCount;
  });
}

export async function getUsageCount(shopId: string): Promise<number> {
  const { periodStart } = currentUtcPeriod();
  const row = await retryDb(() =>
    db.billingUsage.findUnique({
      where: { shopId_periodStart: { shopId, periodStart } },
      select: { responsesCount: true },
    }),
  );
  return row?.responsesCount ?? 0;
}

/**
 * Record a survey response.
 *
 * Duplicate submissions are a success, not an error: the unique constraint on
 * (shopId, orderId) makes a double-tap, a refresh, or a retry after a cold
 * start resolve to the original row. The buyer sees the same confirmation
 * either way.
 */
export async function submitResponse(input: SubmitInput): Promise<SubmitResult> {
  const otherText = input.otherText ? input.otherText.trim().slice(0, MAX_OTHER_LENGTH) : null;

  // Check cap BEFORE insert so the counter reflects stored rows. Incrementing
  // first would leak usage on every duplicate retry.
  const usedBefore = await getUsageCount(input.shopId);
  const capStatus = evaluateCap(input.plan, usedBefore);
  // At cap we still store the answer — losing a buyer's answer to a billing
  // state would be worse than free overage — but flag it for the merchant.
  const shouldLock = capStatus.shouldFlag;

  try {
    const created = await retryDb(() =>
      db.surveyResponse.create({
        data: {
          shopId: input.shopId,
          orderId: input.orderId,
          channel: input.channel,
          otherText,
          locale: input.locale,
          isLocked: shouldLock,
        },
        select: { id: true, isLocked: true },
      }),
    );

    await incrementUsage(input.shopId);

    logger.info("response_created", {
      shop_id: input.shopId,
      response_id: created.id,
      channel: input.channel,
      is_locked: created.isLocked,
    });

    return { outcome: "created", id: created.id, isLocked: created.isLocked };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Duplicate. Return the existing row so the buyer still gets a
      // confirmation, and do NOT increment usage again.
      const existing = await retryDb(() =>
        db.surveyResponse.findUnique({
          where: { shopId_orderId: { shopId: input.shopId, orderId: input.orderId } },
          select: { id: true, isLocked: true },
        }),
      );

      if (existing) {
        logger.info("response_duplicate_ignored", {
          shop_id: input.shopId,
          response_id: existing.id,
          channel: input.channel,
        });
        return { outcome: "duplicate", id: existing.id, isLocked: existing.isLocked };
      }

      // The row vanished between the failed insert and this read — a race with
      // a purge or redact. Nothing to confirm, but the buyer still gets a
      // friendly acknowledgement rather than an error.
      logger.warn("response_duplicate_row_missing", { shop_id: input.shopId, order_id: input.orderId });
      return { outcome: "duplicate", id: "", isLocked: shouldLock };
    }

    throw error;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002";
}

/**
 * Attach cached order data to a response that arrived before its webhook.
 * Called from the orders/create and orders/updated handlers.
 */
export async function reconcileResponsesForOrder(params: {
  shopId: string;
  orderId: string;
  currency: string;
  totalPrice: string;
}): Promise<{ reconciled: number }> {
  const parsed = parseMoneyToMinor(params.totalPrice, params.currency);
  if (!parsed.ok) {
    logger.warn("reconcile_skipped_unparseable_total", {
      shop_id: params.shopId,
      order_id: params.orderId,
      reason: parsed.reason,
    });
    return { reconciled: 0 };
  }

  const decimal = (parsed.minor / 10 ** parsed.decimals).toFixed(parsed.decimals);

  const result = await retryDb(() =>
    db.surveyResponse.updateMany({
      where: { shopId: params.shopId, orderId: params.orderId, reconciled: false },
      data: {
        currency: params.currency,
        orderTotal: decimal,
        reconciled: true,
        unreconcilable: false,
      },
    }),
  );

  if (result.count > 0) {
    logger.info("responses_reconciled", {
      shop_id: params.shopId,
      order_id: params.orderId,
      count: result.count,
    });
  }

  return { reconciled: result.count };
}

/**
 * Mark responses that never received an order after 24 hours. They stay in the
 * dashboard as "Pending" with an explanation rather than being deleted —
 * the answer is real even if the order total is missing.
 */
export async function markUnreconcilable(olderThanHours = 24, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanHours * 60 * 60 * 1000);

  const result = await retryDb(() =>
    db.surveyResponse.updateMany({
      where: { reconciled: false, unreconcilable: false, submittedAt: { lt: cutoff } },
      data: { unreconcilable: true },
    }),
  );

  if (result.count > 0) {
    logger.info("responses_marked_unreconcilable", { count: result.count, older_than_hours: olderThanHours });
  }

  return result.count;
}

/**
 * Run `markUnreconcilable` at most once per process, opportunistically, on a
 * normal request.
 *
 * Render's free tier grants 750 instance hours per month against 744 in a
 * 31-day month, so a second service for scheduled work would guarantee a
 * mid-month suspension. Sweeping inline keeps the deployment to one web
 * service. The guard is per-process, not per-request, because this is a
 * write on an otherwise read-only path.
 */
let lastUnreconcilableSweep: number | undefined;

export async function maybeMarkUnreconcilable(olderThanHours = 24): Promise<void> {
  const intervalMs = 60 * 60 * 1000;
  const now = Date.now();

  if (lastUnreconcilableSweep !== undefined && now - lastUnreconcilableSweep < intervalMs) {
    return;
  }

  // Set before awaiting so concurrent requests on a cold process cannot both
  // trigger a sweep.
  lastUnreconcilableSweep = now;

  try {
    await markUnreconcilable(olderThanHours);
  } catch (error) {
    // Must not fail the caller's request: this is housekeeping, and the
    // retry inside markUnreconcilable has already been exhausted.
    logger.warn("unreconcilable_sweep_failed", serialiseError(error));
  }
}
