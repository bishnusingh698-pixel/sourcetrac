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
  const [responseCount, orderCount, channels] = await Promise.all([
    retryDb(() => db.surveyResponse.count({ where: { shopId: shop.id } })),
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
    response_count: responseCount,
    // Logged for the audit trail only; the values are never stored.
    has_email: Boolean(params.customerEmail),
    has_phone: Boolean(params.customerPhone),
  });

  const breakdown = channels
    .map((c) => `${c.channel}: ${c._count.channel}`)
    .join(", ");

  return {
    shopFound: true,
    // No customer identifier is stored, so no per-customer order list can be
    // produced. Returning one would mean returning other buyers' orders.
    ordersFound: [],
    note:
      "SourceTrac stores no customer contact details (no name, email, phone or " +
      "address) and no customer ID, so no records are attributable to the " +
      "individual who made this request. For this shop we hold " +
      `${responseCount} survey response(s) across ${orderCount} cached order(s)` +
      (breakdown ? `, by channel: ${breakdown}. ` : ". ") +
      "Each response contains only an order ID, the channel selected, and the " +
      "timestamp. Merchant-level totals are available from the SourceTrac " +
      "dashboard.",
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
 */
export async function handleCustomerRedact(params: {
  shopDomain: string;
  orderIds: string[];
}): Promise<{ shopFound: boolean; deletedResponses: number; deletedOrders: number }> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return { shopFound: false, deletedResponses: 0, deletedOrders: 0 };
  }

  const orderIds = [...new Set(params.orderIds)];
  if (orderIds.length === 0) {
    // Shopify sends an empty array when it holds no order link for this
    // customer. Nothing of ours is attributable, so there is nothing to delete.
    logger.info("compliance_customer_redact_empty", { shop_id: shop.id });
    return { shopFound: true, deletedResponses: 0, deletedOrders: 0 };
  }

  const scope = { shopId: shop.id, orderId: { in: orderIds } };

  // OrderCache first: SurveyResponse rows carry the reconciled order total, so
  // they must not outlive the order they describe.
  // Prisma returns `{ count }` from deleteMany, not a bare number.
  const deletedOrders = (await retryDb(() => db.orderCache.deleteMany({ where: scope }))).count;
  const deletedResponses = (await retryDb(() => db.surveyResponse.deleteMany({ where: scope }))).count;

  logger.info("compliance_customer_redact", {
    shop_id: shop.id,
    requested_orders: orderIds.length,
    deleted_responses: deletedResponses,
    deleted_orders: deletedOrders,
  });

  return { shopFound: true, deletedResponses, deletedOrders };
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
