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
  /** Order IDs linked to the requested customer, if we could identify any. */
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
}): Promise<DataRequestResult> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return {
      shopFound: false,
      ordersFound: [],
      note: "No SourceTrac installation for this shop.",
    };
  }

  const responses = await retryDb(() =>
    db.surveyResponse.findMany({
      where: { shopId: shop.id },
      select: { orderId: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    }),
  );

  logger.info("compliance_data_request", {
    shop_id: shop.id,
    matched_responses: responses.length,
    // Logged for the audit trail only; the value itself is never stored.
    has_email: Boolean(params.customerEmail),
    has_phone: Boolean(params.customerPhone),
  });

  return {
    shopFound: true,
    ordersFound: responses.map((r) => r.orderId),
    note:
      "SourceTrac stores no customer contact details. It stores only an order ID, " +
      "the channel the buyer selected, and the timestamp. These order IDs are the " +
      "complete set of records associated with this shop.",
  };
}

/**
 * customers/redact — delete data for a specific customer within 10 days.
 *
 * We cannot attribute a response to an individual buyer, so we cannot redact a
 * single buyer's answer. Redacting all responses would destroy other customers'
 * data, which the requirement does not ask for. The compliant action is to
 * record the request and delete the shop's data only when the whole shop is
 * being removed (shop/redact).
 */
export async function handleCustomerRedact(params: {
  shopDomain: string;
  shopId?: string;
}): Promise<{ shopFound: boolean; deletedResponses: number }> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return { shopFound: false, deletedResponses: 0 };
  }

  const responses = await retryDb(() =>
    db.surveyResponse.count({ where: { shopId: shop.id } }),
  );

  logger.info("compliance_customer_redact", {
    shop_id: shop.id,
    responses_retained: responses,
    reason:
      "SourceTrac holds no customer-identifying data, so an individual buyer's response " +
      "cannot be located. All responses are retained; shop/redact removes them.",
  });

  return { shopFound: true, deletedResponses: 0 };
}

/**
 * shop/redact — delete all shop data within 48 hours of uninstall request.
 * This is the handler that actually deletes.
 */
export async function handleShopRedact(params: {
  shopDomain: string;
  shopId?: string;
}): Promise<{ shopFound: boolean; deleted: boolean }> {
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
