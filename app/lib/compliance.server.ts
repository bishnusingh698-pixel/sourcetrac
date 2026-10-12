import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { findShopByDomain } from "~/lib/shop.server";

/**
 * GDPR / CCPA mandatory webhook handlers.
 *
 * Source: https://shopify.dev/docs/apps/build/privacy-law-compliance
 *
 * SourceTrac deliberately stores no customer-identifying data. A response has
 * shop_id, order_id, channel, timestamp and nothing else — no email, no name,
 * no address, no customer GID, even when the session token carried a `sub`
 * claim. That is what makes these handlers correct and short.
 *
 * A data_export job is only required when you hold personal data. We still
 * export the order IDs we associate with a customer, because that is the only
 * thing we hold about them, and answering accurately is better than arguing
 * the boundary with a compliance officer.
 */

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

export type DataRequestResult = {
  shopFound: boolean;
  /**
   * Always empty in practice: no customer identifier is stored, so there is no
   * way to scope a response to one individual without over-disclosing.
   */
  ordersFound: string[];
  note: string;
};

/**
 * customers/data_request — export data for a specific customer.
 *
 * The webhook payload identifies the customer by email/phone. We do not index
 * those, so we cannot match them to specific responses. We return the shop's
 * orders that have a survey response, and document why.
 *
 * There is no `shopId` parameter. The shop is always resolved from the payload's
 * `shop_domain`, which the webhook handler already verified; accepting an id as
 * well would have been an unvalidated second way to address the same shop.
 */
export async function handleDataRequest(params: {
  shopDomain: string;
  customerEmail?: string;
  customerPhone?: string;
  orderIds?: string[];
}): Promise<DataRequestResult> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return {
      shopFound: false,
      ordersFound: [],
      note: "No SourceTrac installation for this shop.",
    };
  }

  // Shopify does not send `orders_to_redact` on this topic, so there is no
  // order list to scope to. Falling back to "every response for the shop" would
  // hand one customer's data request the order IDs of every other buyer on the
  // shop -- a larger disclosure than the request asks for, and one that grows
  // with the shop's size. Returning the channels we hold instead answers the
  // actual question: what did we keep about this shop's buyers.
  const [responseCount, v2ResponseCount, orderCount, channels] = await Promise.all([
    retryDb(() => db.surveyResponse.count({ where: { shopId: shop.id } })),
    retryDb(() => db.response.count({ where: { shopId: shop.id } })),
    retryDb(() => db.orderCache.count({ where: { shopId: shop.id } })),
    retryDb(() =>
      db.surveyResponse.groupBy({
        by: ["channel"],
        where: { shopId: shop.id },
        _count: { channel: true },
      }),
    ),
  ]);

  logger.info("compliance_data_request", {
    shop_id: shop.id,
    response_count: responseCount + v2ResponseCount,
    // Logged for the audit trail only; the values are never stored.
    has_email: Boolean(params.customerEmail),
    has_phone: Boolean(params.customerPhone),
  });

  const breakdown = channels
    .map((c) => `${c.channel}: ${c._count.channel}`)
    .join(", ");

  const note =
    "SourceTrac stores no customer contact details (no name, email, phone or " +
    "address) and no customer ID, so no records are attributable to the " +
    "individual who made this request. For this shop we hold " +
    `${responseCount + v2ResponseCount} survey response(s) across ${orderCount} cached order(s)` +
    (breakdown ? `, by channel: ${breakdown}. ` : ". ") +
    "Each response contains only an order ID, the channel selected, and the " +
    "timestamp. Merchant-level totals are available from the SourceTrac " +
    "dashboard.";

  // Record that a data request was answered, so the merchant can see it on the
  // Settings page for the retention window. The stored payload is the export
  // summary, never the buyer's identifiers — we hold none to store.
  await retryDb(() =>
    db.dataRequest.create({
      data: {
        shopId: shop.id,
        customerId: null,
        payload: JSON.stringify({ note, responseCount: responseCount + v2ResponseCount, orderCount }),
      },
    }),
  );

  return {
    shopFound: true,
    // No customer identifier is stored, so no per-customer order list can be
    // produced. Returning one would mean returning other buyers' orders.
    ordersFound: [],
    note,
  };
}

/**
 * customers/redact — delete data linked to the given orders within 10 days.
 *
 * We hold no customer contact details, so we cannot find a buyer's rows by
 * email or phone. We do not need to: Shopify tells us exactly which orders to
 * redact in `orders_to_redact`, and `SurveyResponse.orderId` /
 * `OrderCache.orderId` store `String(order.id)` from the REST payload — the
 * same numeric ID that appears in that array. The join is exact.
 *
 * Deleting only these rows is what the requirement asks for. Wiping the whole
 * shop would destroy other buyers' answers, which it does not.
 *
 * A redact can name thousands of orders for a busy store, which will not finish
 * inside the webhook's 5-second budget. Past `REDACT_BATCH_SIZE` the request is
 * recorded in `PendingDeletion` and only the first batch runs inline; the rest
 * is drained lazily by `processPendingDeletions`, so the webhook stays fast and
 * Shopify never sees a timeout.
 */
export async function handleCustomerRedact(params: {
  shopDomain: string;
  orderIds: string[];
}): Promise<{ shopFound: boolean; deletedResponses: number; deletedOrders: number; deletedV2Responses: number; deferred: boolean }> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return { shopFound: false, deletedResponses: 0, deletedOrders: 0, deletedV2Responses: 0, deferred: false };
  }

  const orderIds = [...new Set(params.orderIds)];
  if (orderIds.length === 0) {
    // Shopify sends an empty array when it holds no order link for this
    // customer. Nothing of ours is attributable, so there is nothing to delete.
    logger.info("compliance_customer_redact_empty", { shop_id: shop.id });
    return { shopFound: true, deletedResponses: 0, deletedOrders: 0, deletedV2Responses: 0, deferred: false };
  }

  if (orderIds.length > REDACT_BATCH_SIZE) {
    // Store only the orders the inline pass will NOT delete, so the lazy drain
    // resumes where this left off rather than re-scanning the whole set.
    const remaining = orderIds.slice(REDACT_BATCH_SIZE);
    await retryDb(() =>
      db.pendingDeletion.create({
        data: { shopId: shop.id, scope: "customer", payload: JSON.stringify({ orderIds: remaining }) },
      }),
    );
    logger.info("compliance_customer_redact_deferred", {
      shop_id: shop.id,
      orders: orderIds.length,
      remaining: remaining.length,
    });
    const first = await deleteOrdersForShop(shop.id, orderIds.slice(0, REDACT_BATCH_SIZE));
    return { shopFound: true, ...first, deferred: true };
  }

  const deleted = await deleteOrdersForShop(shop.id, orderIds);
  return { shopFound: true, ...deleted, deferred: false };
}

/** Orders a redact may delete inline before the work is deferred. */
export const REDACT_BATCH_SIZE = 200;

/**
 * Delete the rows Shopify named. v2 responses go first (their Answers cascade
 * and their PendingSync rows would otherwise be orphaned), then the legacy
 * responses, then the order cache — which must not outlive the responses whose
 * totals were reconciled from it.
 */
async function deleteOrdersForShop(
  shopId: string,
  orderIds: string[],
): Promise<{ deletedResponses: number; deletedOrders: number; deletedV2Responses: number }> {
  if (orderIds.length === 0) return { deletedResponses: 0, deletedOrders: 0, deletedV2Responses: 0 };
  const scope = { shopId, orderId: { in: orderIds } };

  const v2ResponseIds = (
    await retryDb(() => db.response.findMany({ where: scope, select: { id: true } }))
  ).map((row) => row.id);
  if (v2ResponseIds.length > 0) {
    await retryDb(() => db.pendingSync.deleteMany({ where: { shopId, responseId: { in: v2ResponseIds } } }));
  }
  const deletedV2Responses = (await retryDb(() => db.response.deleteMany({ where: scope }))).count;
  const deletedOrders = (await retryDb(() => db.orderCache.deleteMany({ where: scope }))).count;
  const deletedResponses = (await retryDb(() => db.surveyResponse.deleteMany({ where: scope }))).count;

  logger.info("compliance_customer_redact", {
    shop_id: shopId,
    requested_orders: orderIds.length,
    deleted_responses: deletedResponses,
    deleted_v2_responses: deletedV2Responses,
    deleted_orders: deletedOrders,
  });

  return { deletedResponses, deletedOrders, deletedV2Responses };
}

/**
 * Drain deferred redacts for one shop, a batch at a time. Each pass removes the
 * orders it deleted from the stored payload, so a crash mid-batch resumes rather
 * than restarting, and the row is dropped once nothing is left.
 */
export async function processPendingDeletions(shopId: string, maxBatches = 5): Promise<{ processed: number; remaining: number }> {
  let processed = 0;
  let remaining = 0;

  const pending = await retryDb(() =>
    db.pendingDeletion.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
  );

  for (const row of pending) {
    let orderIds: string[] = [];
    try {
      const parsed = JSON.parse(row.payload) as { orderIds?: unknown };
      orderIds = Array.isArray(parsed.orderIds)
        ? parsed.orderIds.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      orderIds = [];
    }

    let batches = 0;
    while (orderIds.length > 0 && batches < maxBatches) {
      const batch = orderIds.slice(0, REDACT_BATCH_SIZE);
      await deleteOrdersForShop(shopId, batch);
      orderIds = orderIds.slice(REDACT_BATCH_SIZE);
      processed += batch.length;
      batches += 1;
    }

    if (orderIds.length === 0) {
      await retryDb(() => db.pendingDeletion.delete({ where: { id: row.id } }));
    } else {
      await retryDb(() =>
        db.pendingDeletion.update({ where: { id: row.id }, data: { payload: JSON.stringify({ orderIds }) } }),
      );
      remaining += orderIds.length;
    }
  }

  return { processed, remaining };
}

let lastDeletionSweep: number | undefined;
const DELETION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Drain deferred redacts at most once per few minutes per process, never throwing. */
export async function maybeRunPendingDeletions(shopId: string): Promise<void> {
  const now = Date.now();
  if (lastDeletionSweep !== undefined && now - lastDeletionSweep < DELETION_SWEEP_INTERVAL_MS) return;
  lastDeletionSweep = now;
  try {
    const result = await processPendingDeletions(shopId);
    if (result.processed > 0 || result.remaining > 0) {
      logger.info("compliance_deferred_redact_drained", {
        shop_id: shopId,
        processed: result.processed,
        remaining: result.remaining,
      });
    }
  } catch (error) {
    lastDeletionSweep = undefined;
    logger.warn("compliance_deferred_redact_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * shop/redact — delete all shop data within 48 hours of uninstall request.
 * This is the handler that actually deletes.
 */
export async function handleShopRedact(params: {
  shopDomain: string;
  shopId?: string;
}): Promise<{ shopFound: boolean; deleted: boolean }> {
  // Sessions hold access tokens (and, for online sessions, a staff member's
  // name and email). They are deleted even when no shop row remains.
  await retryDb(() => db.session.deleteMany({ where: { shop: params.shopDomain } }));

  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    logger.info("compliance_shop_redact_noop", { shop_domain: params.shopDomain });
    return { shopFound: false, deleted: false };
  }

  // Foreign keys cascade: survey_responses, orders_cache, billing_usage and
  // webhook_events are all removed with the shop row.
  await retryDb(() => db.shop.delete({ where: { id: shop.id } }));

  logger.info("compliance_shop_redact", { shop_id: shop.id, shop_domain: params.shopDomain });
  return { shopFound: true, deleted: true };
}
