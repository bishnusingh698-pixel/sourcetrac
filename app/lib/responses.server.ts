import { db, isRetryableDbError } from "~/db.server";
import { serialiseError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { minorToDecimalString, parseMoneyToMinor } from "~/lib/money";
import { markUnverifiedFailedResponses } from "~/lib/answers.server";
import { currentUtcPeriod } from "~/lib/plans";
import { withRetry } from "~/lib/retry.server";

/**
 * Answers from the original single-question survey (`SurveyResponse`):
 * reconciling them with their orders and ageing out the ones whose order
 * never arrived, plus the Free cap's usage count. Nothing writes new rows
 * here any more: every block answers through `answers.server.ts`.
 */

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
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
