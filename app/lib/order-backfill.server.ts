import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { getAccessToken } from "~/lib/shop.server";
import { isThrottle, shopifyGraphql, ShopifyGraphQLError } from "~/lib/shopify-graphql.server";
import { startSyncForOrder } from "~/lib/sync.server";
import { upsertOrderCache, type ShopifyOrder } from "~/lib/webhooks.server";

/**
 * Fetch orders the webhooks never delivered.
 *
 * `OrderCache` is filled only by `orders/*` webhooks, so an answer whose order
 * never produced one stayed "Pending" forever and was then written off as
 * "order not received". That happens to:
 *   - orders placed BEFORE the app was installed (a buyer answers on the Order
 *     status page of an older order; on a test store this is usually the very
 *     first thing a merchant tries),
 *   - orders placed while the app was uninstalled, whose webhooks are ignored,
 *   - deliveries Shopify gave up on after its retry window.
 *
 * This asks the Admin API for those orders and writes them through the very
 * same `upsertOrderCache` as the webhook, which also reconciles the answer.
 * `read_orders` covers the last 60 days, so older answers are not attempted.
 */

const ORDER_QUERY = `#graphql
  query SourceTracOrder($id: ID!) {
    order(id: $id) {
      legacyResourceId
      name
      test
      cancelledAt
      createdAt
      updatedAt
      displayFinancialStatus
      sourceName
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

type OrderNode = {
  legacyResourceId: string;
  name: string | null;
  test: boolean;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string | null;
  sourceName?: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
};

/** The webhook payload shape `upsertOrderCache` reads, from the GraphQL order. */
export function orderNodeToPayload(node: OrderNode): ShopifyOrder {
  return {
    id: node.legacyResourceId,
    name: node.name,
    // `current_total_price` and `currency` in the REST payload are both in the
    // shop's currency, i.e. `shopMoney`, never the buyer's presentment money.
    currency: node.currentTotalPriceSet?.shopMoney.currencyCode ?? "",
    current_total_price: node.currentTotalPriceSet?.shopMoney.amount ?? null,
    // GraphQL's enum (PARTIALLY_REFUNDED) is the REST value (partially_refunded) upper-cased.
    financial_status: node.displayFinancialStatus ? node.displayFinancialStatus.toLowerCase() : null,
    test: node.test,
    cancelled_at: node.cancelledAt,
    source_name: node.sourceName ?? null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

/** Give Shopify a moment to deliver `orders/create` before asking ourselves. */
const MIN_AGE_MS = 2 * 60 * 1000;
/** `read_orders` only reaches back 60 days; stay safely inside it. */
const MAX_AGE_MS = 58 * 24 * 60 * 60 * 1000;
/** Per shop and call, so one dashboard load cannot fan out unboundedly. */
const BATCH = 10;
/** An order whose lookup failed (timeout, throttle) is retried after an hour. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
/**
 * An order Shopify answered with "no such order" (deleted, or older than the
 * 60-day `read_orders` window even though the answer is recent) is not asked
 * for again for a week, instead of failing every hour.
 */
const NOT_FOUND_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** shop:order -> when it may be asked for again. Pruned as it is read. */
const nextAttempt = new Map<string, number>();
/** One backfill per shop at a time: parallel admin loaders share it. */
const inFlight = new Map<string, Promise<number>>();

function pruneAttempts(nowMs: number): void {
  for (const [key, at] of nextAttempt) if (at <= nowMs) nextAttempt.delete(key);
}

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

/**
 * Start the backfill for a shop in the background. Admin loaders call this
 * instead of awaiting it: up to ten Admin API calls (each with its own timeout
 * and retries) used to sit in front of every page render. Answers it resolves
 * show on the next load.
 */
export function startOrderBackfill(params: { shopId: string; shopDomain: string; accessToken?: string | null }): void {
  void backfillMissingOrders(params);
}

/**
 * Backfill the missing orders of one shop's unreconciled answers, both the
 * legacy `SurveyResponse` rows and the v2 `Response` rows the checkout blocks
 * write. Returns how many orders were written. Never throws. Concurrent calls
 * for one shop share a single run.
 */
export async function backfillMissingOrders(params: {
  shopId: string;
  shopDomain: string;
  accessToken?: string | null;
  now?: Date;
}): Promise<number> {
  const running = inFlight.get(params.shopId);
  if (running) return running;
  const run = runBackfill(params).finally(() => inFlight.delete(params.shopId));
  inFlight.set(params.shopId, run);
  return run;
}

async function runBackfill(params: {
  shopId: string;
  shopDomain: string;
  accessToken?: string | null;
  now?: Date;
}): Promise<number> {
  const now = params.now ?? new Date();
  pruneAttempts(now.getTime());

  try {
    const after = new Date(now.getTime() - MAX_AGE_MS);
    const before = new Date(now.getTime() - MIN_AGE_MS);
    // Orders waiting out a retry are left out in the query itself: filtered
    // after the LIMIT, a hundred parked orders starved every older one.
    const prefix = `${params.shopId}:`;
    const parked = [...nextAttempt.entries()]
      .filter(([key, at]) => key.startsWith(prefix) && at > now.getTime())
      .map(([key]) => key.slice(prefix.length));
    const candidates = await retryDb(() =>
      db.$queryRaw<Array<{ orderId: string }>>`
        SELECT c."orderId", MAX(c.at) AS at FROM (
          SELECT r."orderId", r."submittedAt" AS at
          FROM "SurveyResponse" r
          WHERE r."shopId" = ${params.shopId}
            AND r.reconciled = false
            AND r."submittedAt" < ${before} AND r."submittedAt" > ${after}
          UNION ALL
          SELECT v."orderId", v."createdAt" AS at
          FROM "Response" v
          WHERE v."shopId" = ${params.shopId}
            AND v."orderId" IS NOT NULL
            AND v."orderTotal" IS NULL
            AND v."createdAt" < ${before} AND v."createdAt" > ${after}
        ) c
        LEFT JOIN "OrderCache" o
          ON o."shopId" = ${params.shopId} AND o."orderId" = c."orderId"
        -- Missing, or stored with a total that could not be read: read again.
        WHERE (o.id IS NULL OR o."totalPrice" IS NULL)
          AND NOT (c."orderId" = ANY(${parked}::text[]))
        GROUP BY c."orderId"
        ORDER BY at DESC
        LIMIT 100
      `,
    );

    const due = candidates
      .map((row) => row.orderId)
      .filter((orderId) => !nextAttempt.has(`${params.shopId}:${orderId}`))
      .slice(0, BATCH);
    if (due.length === 0) return 0;

    const accessToken = params.accessToken ?? (await getAccessToken(params.shopId));
    if (!accessToken) return 0;

    let written = 0;
    for (const orderId of due) {
      const key = `${params.shopId}:${orderId}`;
      nextAttempt.set(key, now.getTime() + RETRY_AFTER_MS);
      try {
        const result = await shopifyGraphql<{ order: OrderNode | null }>(params.shopDomain, accessToken, ORDER_QUERY, {
          id: `gid://shopify/Order/${orderId}`,
        });
        if (!result.data.order) {
          nextAttempt.set(key, now.getTime() + NOT_FOUND_RETRY_MS);
          logger.info("order_backfill_not_found", { shop_id: params.shopId, order_id: orderId });
          continue;
        }
        const outcome = await upsertOrderCache(params.shopId, orderNodeToPayload(result.data.order), false);
        if (!outcome) {
          // Shopify's answer cannot be stored (no total or currency): asking
          // again every hour would get the same answer.
          nextAttempt.set(key, now.getTime() + NOT_FOUND_RETRY_MS);
          logger.warn("order_backfill_unstorable", { shop_id: params.shopId, order_id: orderId });
          continue;
        }
        if (outcome.applied) written += 1;
        // Sync work waiting for this order can run now, as on orders/create.
        if (outcome?.created) startSyncForOrder(params.shopId, orderId);
      } catch (error) {
        // One order failing must not stop the rest of the batch. A permanent
        // GraphQL error (an order past the 60-day window answers with an
        // access error) waits a week; a throttle or 5xx retries in an hour.
        //
        // A refused token (401/403) is about the shop, not this order: no order
        // is parked for it, and the rest of the batch would fail the same way.
        if (isAuthFailure(error)) {
          nextAttempt.delete(key);
          logger.warn("order_backfill_auth_failed", {
            shop_id: params.shopId,
            error_message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        if (error instanceof ShopifyGraphQLError && !isThrottle(error)) {
          nextAttempt.set(key, now.getTime() + NOT_FOUND_RETRY_MS);
        }
        logger.warn("order_backfill_failed", {
          shop_id: params.shopId,
          order_id: orderId,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (written > 0) logger.info("order_backfill_written", { shop_id: params.shopId, count: written });
    return written;
  } catch (error) {
    logger.warn("order_backfill_skipped", {
      shop_id: params.shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/** For tests: forget which orders were already attempted. */
export function resetBackfillAttempts(): void {
  nextAttempt.clear();
  inFlight.clear();
}

/** Shopify refused the request itself (bad or revoked token), not the order. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof ShopifyGraphQLError && /^Shopify returned (401|403)\b/.test(error.message);
}
