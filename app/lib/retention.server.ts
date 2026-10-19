import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { processPendingDeletions } from "~/lib/compliance.server";
import { CHECKOUT_LOAD_RETENTION_DAYS } from "~/lib/serve-log.server";

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
/** Data-request records are transient, not records. */
export const DATA_REQUEST_RETENTION_DAYS = 30;
/**
 * A shop uninstalled this long ago whose shop/redact never arrived (Shopify
 * sends it 48 hours after uninstall) is deleted by retention as a backstop.
 */
export const UNINSTALLED_SHOP_RETENTION_DAYS = 30;
/** How long the Thank-you page's first-order flag for an order is kept. */
export const ORDER_FACT_RETENTION_DAYS = 90;

export type RetentionReport = {
  webhookEventsDeleted: number;
  orderCacheDeleted: number;
  surveyResponsesDeleted: number;
  responsesDeleted: number;
  answersDeleted: number;
  dailyStatsDeleted: number;
  pendingSyncDeleted: number;
  dataRequestsDeleted: number;
  /** "Recent checkouts" rows past their 30 days. */
  checkoutLoadsDeleted: number;
  orderFactsDeleted: number;
  /** Deferred redacts executed (not discarded) by this pass. */
  pendingDeletionsDeleted: number;
  redactedOrdersDeleted: number;
  uninstalledShopsDeleted: number;
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
  // Every row past the window goes, processed or not. Shopify stops retrying a
  // delivery within hours, so a row that failed 30 days ago can never be
  // redelivered; keeping only processed rows eligible meant failed ones
  // accumulated forever against the 0.5 GB free tier.
  const webhookEventsDeleted = (
    await retryDb(() =>
      db.webhookEvent.deleteMany({
        where: {
          createdAt: { lt: webhookCutoff },
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

  // The v2 model. `Answer` cascades from `Response` in the schema (daily stats
  // do not: they are keyed by survey and day, and age out below), but answers
  // are still deleted explicitly first so the report is honest about what was
  // removed. Ordering matters: answers reference responses, so responses go last.
  const answersDeleted = (
    await retryDb(() => db.answer.deleteMany({ where: { response: { createdAt: { lt: recordCutoff } } } }))
  ).count;

  const responsesDeleted = (
    await retryDb(() => db.response.deleteMany({ where: { createdAt: { lt: recordCutoff } } }))
  ).count;

  // Deferred Shopify writes never applied. They hold no payload, only ids, but
  // a row for a response that no longer exists can never succeed, so clear
  // anything older than the record window.
  const pendingSyncDeleted = (
    await retryDb(() => db.pendingSync.deleteMany({ where: { createdAt: { lt: recordCutoff } } }))
  ).count;

  // Daily stats are keyed by a UTC day string, not a timestamp, so the cutoff
  // is compared as the same "YYYY-MM-DD" form. These are aggregates with no
  // order link, but the published policy says two years, so they age out too.
  const statsCutoffDay = recordCutoff.toISOString().slice(0, 10);
  const dailyStatsDeleted = (
    await retryDb(() => db.surveyDailyStats.deleteMany({ where: { day: { lt: statsCutoffDay } } }))
  ).count;

  // Data-request records are a notification inbox, not buyer records, so they
  // age out on the same 30-day clock as webhook payloads.
  const dataRequestCutoff = daysAgo(DATA_REQUEST_RETENTION_DAYS, now);
  const dataRequestsDeleted = (
    await retryDb(() => db.dataRequest.deleteMany({ where: { createdAt: { lt: dataRequestCutoff } } }))
  ).count;

  // "Recent checkouts" is a short diagnostic window, not a record.
  const checkoutLoadsDeleted = (
    await retryDb(() =>
      db.checkoutLoad.deleteMany({ where: { at: { lt: daysAgo(CHECKOUT_LOAD_RETENTION_DAYS, now) } } }),
    )
  ).count;

  // A first-order flag only matters while the buyer may still open the order's
  // status page, so it is kept far shorter than the answers.
  const orderFactsDeleted = (
    await retryDb(() => db.orderFact.deleteMany({ where: { createdAt: { lt: daysAgo(ORDER_FACT_RETENTION_DAYS, now) } } }))
  ).count;

  // Deferred redacts are a deletion obligation, never something to discard:
  // every queued one is EXECUTED here, whatever its age.
  const pendingShops = await retryDb(() =>
    db.pendingDeletion.findMany({ distinct: ["shopId"], select: { shopId: true } }),
  );
  let pendingDeletionsDeleted = 0;
  for (const { shopId } of pendingShops) {
    const before = await retryDb(() => db.pendingDeletion.count({ where: { shopId } }));
    await processPendingDeletions(shopId, Number.POSITIVE_INFINITY);
    const after = await retryDb(() => db.pendingDeletion.count({ where: { shopId } }));
    pendingDeletionsDeleted += before - after;
  }

  // Redaction tombstones keep a redacted order from being stored again; they
  // age out on the record clock like the orders they stand for.
  const redactedOrdersDeleted = (
    await retryDb(() => db.redactedOrder.deleteMany({ where: { createdAt: { lt: recordCutoff } } }))
  ).count;

  // Backstop for a shop/redact that never arrived: an uninstalled shop past
  // the window is deleted with everything it owns, sessions included.
  const uninstalledCutoff = daysAgo(UNINSTALLED_SHOP_RETENTION_DAYS, now);
  const abandoned = await retryDb(() =>
    db.shop.findMany({
      where: { installState: "uninstalled", uninstalledAt: { lt: uninstalledCutoff } },
      select: { id: true, shopDomain: true },
    }),
  );
  for (const shop of abandoned) {
    await retryDb(() => db.session.deleteMany({ where: { shop: shop.shopDomain } }));
    await retryDb(() => db.shop.deleteMany({ where: { id: shop.id, installState: "uninstalled" } }));
  }
  const uninstalledShopsDeleted = abandoned.length;

  // Orders age by the ORDER's date (an order backfilled years after it was
  // placed is not young), and are kept while a retained answer references it.
  const orderCacheDeleted = await retryDb(
    () => db.$executeRaw`
      DELETE FROM "OrderCache" o
      WHERE o."createdAtShop" < ${recordCutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "SurveyResponse" r
          WHERE r."shopId" = o."shopId" AND r."orderId" = o."orderId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Response" r2
          WHERE r2."shopId" = o."shopId" AND r2."orderId" = o."orderId"
        )
    `,
  );

  const report: RetentionReport = {
    webhookEventsDeleted,
    orderCacheDeleted,
    surveyResponsesDeleted,
    responsesDeleted,
    answersDeleted,
    dailyStatsDeleted,
    pendingSyncDeleted,
    dataRequestsDeleted,
    checkoutLoadsDeleted,
    orderFactsDeleted,
    pendingDeletionsDeleted,
    redactedOrdersDeleted,
    uninstalledShopsDeleted,
    ranAt: now.toISOString(),
  };

  logger.info("retention_purge", {
    ...report,
    webhook_cutoff: webhookCutoff.toISOString(),
    record_cutoff: recordCutoff.toISOString(),
    data_request_cutoff: dataRequestCutoff.toISOString(),
  });

  return report;
}
let lastOpportunisticRun: number | undefined;

/**
 * Run the purge at most once a day per process, piggybacking on traffic that
 * already has the database awake. POST /jobs/retention still works for an
 * external scheduler, but retention no longer depends on one being set up:
 * a forgotten cron job would otherwise keep data past its retention window.
 */
export async function maybeRunRetention(now: Date = new Date()): Promise<void> {
  const dayMs = 24 * 60 * 60 * 1000;
  if (lastOpportunisticRun !== undefined && now.getTime() - lastOpportunisticRun < dayMs) return;
  // Set before awaiting so concurrent requests cannot both start a purge.
  lastOpportunisticRun = now.getTime();

  try {
    await runRetentionPurge(now);
  } catch (error) {
    // Housekeeping must never fail the request that triggered it. Clearing the
    // marker lets the next request retry rather than waiting a full day.
    lastOpportunisticRun = undefined;
    logger.warn("retention_opportunistic_failed", {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}
