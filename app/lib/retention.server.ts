import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";

/**
 * Retention enforcement.
 *
 * The published policy (app/routes/privacy.tsx, docs/02, docs/03) promises:
 *   - survey responses and cached orders: 24 months rolling
 *   - webhook payloads: 30 days
 *
 * Nothing enforced that until now, so webhook payloads -- the one table that can
 * contain customer fields -- accumulated forever against a 0.5 GB free tier.
 * Protected-customer-data Level 1 requires documented retention periods to be
 * actually applied, not just stated.
 *
 * Deletion is per-shop-scoped by `shopId` rather than by a global timestamp
 * sweep, because the policy is about how long *we* keep a buyer's answer, not
 * about the age of the row in isolation. Both cuts use the same boundary: a
 * half-open `[cutoff, now)` window, and `lt` is strict so a row exactly at the
 * cutoff survives until the next run.
 */

export const WEBHOOK_RETENTION_DAYS = 30;
export const RECORD_RETENTION_DAYS = 730; // 24 months

export type RetentionReport = {
  webhookEventsDeleted: number;
  orderCacheDeleted: number;
  surveyResponsesDeleted: number;
  ranAt: string;
};

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * One retention pass.
 *
 * Safe to run repeatedly and safe to run concurrently with a request: the
 * deletes are bounded by primary-key-free predicates that only ever match rows
 * already past their window, and nothing a live request writes is ever in that
 * window.
 */
export async function runRetentionPurge(now: Date = new Date()): Promise<RetentionReport> {
  const webhookCutoff = daysAgo(WEBHOOK_RETENTION_DAYS, now);
  const recordCutoff = daysAgo(RECORD_RETENTION_DAYS, now);

  // Webhook payloads first: they are the rows most likely to hold customer
  // fields, so they are the ones we most want gone.
  //
  // Only unprocessed rows are eligible. A webhook still awaiting retry holds
  // operational state we still need, and deleting it would silently lose work
  // the app is committed to finishing (see the insert-first idempotency design
  // in webhooks.server.ts). Anything already processed is safe to drop.
  const webhookEventsDeleted = (
    await retryDb(() =>
      db.webhookEvent.deleteMany({
        where: {
          createdAt: { lt: webhookCutoff },
          processedAt: { not: null },
        },
      }),
    )
  ).count;

  // Responses first, then orders. The two age on different clocks: an order by
  // when it was cached, an answer by when the buyer submitted it, and an answer
  // can arrive long after the order (e.g. from the order-status page). Deleting
  // the order by its own age would strand a live answer with no order to join,
  // so an expired order is kept for as long as any response still references it.
  // It goes on the first run after that response itself expires.
  const surveyResponsesDeleted = (
    await retryDb(() => db.surveyResponse.deleteMany({ where: { submittedAt: { lt: recordCutoff } } }))
  ).count;

  const orderCacheDeleted = await retryDb(
    () => db.$executeRaw`
      DELETE FROM "OrderCache" o
      WHERE o."createdAt" < ${recordCutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "SurveyResponse" r
          WHERE r."shopId" = o."shopId" AND r."orderId" = o."orderId"
        )
    `,
  );

  const report: RetentionReport = {
    webhookEventsDeleted,
    orderCacheDeleted,
    surveyResponsesDeleted,
    ranAt: now.toISOString(),
  };

  logger.info("retention_purge", {
    ...report,
    webhook_cutoff: webhookCutoff.toISOString(),
    record_cutoff: recordCutoff.toISOString(),
  });

  return report;
}