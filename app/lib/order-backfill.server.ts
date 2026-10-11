import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { getAccessToken } from "~/lib/shop.server";
import { shopifyGraphql } from "~/lib/shopify-graphql.server";
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
/** An order Shopify could not return is not asked for again for an hour. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

const lastAttempt = new Map<string, number>();

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

/**
 * Backfill the missing orders of one shop's unreconciled answers. Returns how
 * many orders were written. Never throws: this runs on the way to rendering the
 * dashboard, and a Shopify hiccup must not take the page down.
 */
export async function backfillMissingOrders(params: {
  shopId: string;
  shopDomain: string;
  accessToken?: string | null;
  now?: Date;
}): Promise<number> {
  const now = params.now ?? new Date();

  try {
    const candidates = await retryDb(() =>
      db.$queryRaw<Array<{ orderId: string }>>`
        SELECT r."orderId"
        FROM "SurveyResponse" r
        LEFT JOIN "OrderCache" o
          ON o."shopId" = r."shopId" AND o."orderId" = r."orderId"
        WHERE r."shopId" = ${params.shopId}
          AND r.reconciled = false
          AND o.id IS NULL
          AND r."submittedAt" < ${new Date(now.getTime() - MIN_AGE_MS)}
          AND r."submittedAt" > ${new Date(now.getTime() - MAX_AGE_MS)}
        ORDER BY r."submittedAt" DESC
        LIMIT 100
      `,
    );

    const due = candidates
      .map((row) => row.orderId)
      .filter((orderId) => {
        const at = lastAttempt.get(`${params.shopId}:${orderId}`);
        return at === undefined || now.getTime() - at >= RETRY_AFTER_MS;
      })
      .slice(0, BATCH);
    if (due.length === 0) return 0;

    const accessToken = params.accessToken ?? (await getAccessToken(params.shopId));
    if (!accessToken) return 0;

    let written = 0;
    for (const orderId of due) {
      lastAttempt.set(`${params.shopId}:${orderId}`, now.getTime());
      try {
        const result = await shopifyGraphql<{ order: OrderNode | null }>(params.shopDomain, accessToken, ORDER_QUERY, {
          id: `gid://shopify/Order/${orderId}`,
        });
        if (!result.data.order) {
          logger.info("order_backfill_not_found", { shop_id: params.shopId, order_id: orderId });
          continue;
        }
        const outcome = await upsertOrderCache(params.shopId, orderNodeToPayload(result.data.order), false);
        if (outcome?.applied) written += 1;
      } catch (error) {
        // One order failing (an order past the 60-day window answers with an
        // access error) must not stop the rest of the batch.
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
  lastAttempt.clear();
}
