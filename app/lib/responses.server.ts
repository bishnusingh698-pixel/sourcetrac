import { db, isRetryableDbError } from "~/db.server";
import { serialiseError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { minorToDecimalString, parseMoneyToMinor } from "~/lib/money";
import { markUnverifiedFailedResponses } from "~/lib/answers.server";
import { currentUtcPeriod, evaluateCap, type PlanKey } from "~/lib/plans";
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
    // One statement, so two first-of-period answers cannot race on the insert
    // (Prisma's upsert is a read-then-write and lost one with a P2002).
    const id = `usage_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const rows = await db.$queryRaw<Array<{ responsesCount: number }>>`
      INSERT INTO "BillingUsage" ("id", "shopId", "periodStart", "periodEnd", "responsesCount", "updatedAt")
      VALUES (${id}, ${shopId}, ${periodStart}, ${periodEnd}, 1, now())
      ON CONFLICT ("shopId", "periodStart") DO UPDATE
        SET "responsesCount" = "BillingUsage"."responsesCount" + 1, "updatedAt" = now()
      RETURNING "responsesCount"
    `;
    return rows[0]?.responsesCount ?? 1;
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

    // The answer is already stored. A failure of the usage counter must not
    // fail the request: the extension would retry, hit the unique constraint and
    // get "duplicate", and a unique violation raised by a concurrent
    // first-of-month usage upsert would be misreported as a duplicate answer.
    let isLocked = created.isLocked;
    try {
      const usedAfter = await incrementUsage(input.shopId);
      // The cap was checked BEFORE the insert, without a lock, so two answers
      // arriving together at cap-1 both passed as unlocked. The increment is an
      // atomic UPDATE, so its result is this answer's true position: re-decide
      // from it and flag the row if it landed past the cap.
      if (!isLocked && evaluateCap(input.plan, usedAfter - 1).shouldFlag) {
        await retryDb(() => db.surveyResponse.update({ where: { id: created.id }, data: { isLocked: true } }));
        isLocked = true;
      }
    } catch (usageError) {
      logger.warn("usage_increment_failed", {
        shop_id: input.shopId,
        response_id: created.id,
        error_message: usageError instanceof Error ? usageError.message : String(usageError),
      });
    }

    // The order webhook usually lands BEFORE the buyer answers, so there is no
    // later orders/create to reconcile this row. Attach the cached order now;
    // otherwise the answer would stay Pending and, after 24h, be marked
    // unreconcilable even though its revenue is known.
    try {
      await reconcileFromOrderCache(input.shopId, input.orderId);
    } catch (reconcileError) {
      logger.warn("submit_reconcile_failed", {
        shop_id: input.shopId,
        response_id: created.id,
        error_message: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      });
    }

    logger.info("response_created", {
      shop_id: input.shopId,
      response_id: created.id,
      channel: input.channel,
      is_locked: isLocked,
    });

    return { outcome: "created", id: created.id, isLocked };
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

/**
 * Reconcile one answer against an order that is already cached. A no-op when the
 * order has not arrived, or arrived with a total we could not parse.
 */
export async function reconcileFromOrderCache(shopId: string, orderId: string): Promise<void> {
  const order = await retryDb(() =>
    db.orderCache.findUnique({
      where: { shopId_orderId: { shopId, orderId } },
      select: { currency: true, totalPrice: true },
    }),
  );
  if (!order || order.totalPrice === null) return;

  await reconcileResponsesForOrder({
    shopId,
    orderId,
    currency: order.currency,
    totalPrice: order.totalPrice.toString(),
  });
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

  // From integer minor units, never float division.
  const decimal = minorToDecimalString(parsed.minor, params.currency);

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
 * Reconcile every unreconciled answer whose order is already cached with a
 * readable total. Idempotent, and a no-op in the normal case. The stored value
 * is copied as-is: it was already validated and rounded to the currency's
 * precision when the order webhook wrote it.
 */
export async function reconcileOrphanedResponses(): Promise<number> {
  const count = await retryDb(() =>
    db.$executeRaw`
      UPDATE "SurveyResponse" r
      SET reconciled = true,
          unreconcilable = false,
          currency = o.currency,
          "orderTotal" = o."totalPrice"
      FROM "OrderCache" o
      WHERE o."shopId" = r."shopId"
        AND o."orderId" = r."orderId"
        AND o."totalPrice" IS NOT NULL
        AND r.reconciled = false
    `,
  );

  if (count > 0) logger.info("responses_reconciled_late", { count });
  return count;
}

/**
 * Mark responses that never received an order after 24 hours. They stay in the
 * dashboard as "Pending" with an explanation rather than being deleted —
 * the answer is real even if the order total is missing.
 */
export async function markUnreconcilable(olderThanHours = 24, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanHours * 60 * 60 * 1000);

  // First recover answers whose order IS cached. Reconciliation runs once at
  // submit and once per order webhook; if the submit-time attempt failed (it is
  // logged and skipped so the buyer still gets a confirmation) and no later
  // orders/updated arrives, the answer would otherwise read "Pending" and then
  // be written off as "order never arrived" for an order we hold.
  await reconcileOrphanedResponses();

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
    // The v2 model uses `unverifiedFailed` in place of the legacy
    // `unreconcilable`, and has no reconcile flag. Marked in the same sweep so a
    // single dashboard visit ages out both shapes.
    await markUnverifiedFailedResponses(olderThanHours);
  } catch (error) {
    // Must not fail the caller's request: this is housekeeping, and the
    // retry inside markUnreconcilable has already been exhausted.
    logger.warn("unreconcilable_sweep_failed", serialiseError(error));
  }
}
