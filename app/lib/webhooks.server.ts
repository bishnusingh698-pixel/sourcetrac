import type { PlanStatus } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { minorToDecimalString, parseMoneyToMinor } from "~/lib/money";
import { withRetry } from "~/lib/retry.server";
import { reconcileResponsesForOrder } from "~/lib/responses.server";
import {
  clearAccessToken,
  findShopByDomain,
  findShopById,
  getAccessToken,
  setCheckoutSupport,
  setPlan,
  upsertShop,
} from "~/lib/shop.server";
import { checkoutSurfacesSupported, fetchShopPlanName } from "~/lib/shopify-rest.server";
import { isPlanKey, type PlanKey } from "~/lib/plans";

/**
 * Webhook processing.
 *
 * Invariants:
 *   1. HMAC is verified by the route (authenticate.webhook) before anything here runs.
 *   2. X-Shopify-Webhook-Id is inserted into webhook_events with a unique
 *      constraint BEFORE any business logic. A concurrent or repeated delivery
 *      loses that insert and returns 200 immediately.
 *   3. Order writes are guarded on `updated_at`, so an out-of-order or replayed
 *      delivery can never overwrite newer data.
 *   4. Only an INSTALLED shop is touched. Webhooks for an unknown or uninstalled
 *      shop are acknowledged and ignored; the one way back to "installed" is the
 *      auth path (provisionShop).
 */

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

/**
 * Resolve the internal id of an INSTALLED shop, or null.
 *
 * This never creates a shop and never flips `installState`. A late `orders/updated`
 * that arrives after `app/uninstalled` used to upsert the shop back to
 * "installed" with no token; now it finds an uninstalled shop and is ignored.
 * Reinstalling happens only through OAuth / token exchange, via provisionShop.
 */
export async function resolveInstalledShop(shopDomain: string, accessToken: string | null): Promise<string | null> {
  const existing = await findShopByDomain(shopDomain);
  if (!existing || existing.installState !== "installed") return null;

  // Keep the stored copy of the offline token fresh. upsertShop leaves the token
  // alone when none is supplied.
  if (accessToken) {
    await upsertShop({ shopDomain, shopId: existing.shopId, accessToken });
  }

  // Only probe the Admin API while the plan check is unresolved or failed, so we
  // do not hit it on every healthy webhook.
  if (!existing.checkoutSupported) {
    void refreshCheckoutSupport(existing.id).catch((error: unknown) => {
      logger.warn("checkout_support_refresh_failed", {
        shop_id: existing.id,
        error_message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return existing.id;
}

export async function refreshCheckoutSupport(internalShopId: string): Promise<void> {
  const shop = await findShopById(internalShopId);
  if (!shop) return;

  const token = await getAccessToken(internalShopId);
  if (!token) return;

  const planName = await fetchShopPlanName(shop.shopDomain, token);
  const supported = checkoutSurfacesSupported(planName);
  await setCheckoutSupport(internalShopId, supported);
}

export type ClaimResult = { claimed: true } | { claimed: false };

/** A delivery with no outcome after this long was abandoned by a crashed request. */
export const INFLIGHT_STALE_MS = 5 * 60 * 1000;

/**
 * Claim a webhook delivery.
 *
 * Insert-first, so a concurrent or repeated delivery loses the insert and is
 * refused: the caller returns 200 and Shopify stops retrying. That is correct for
 * a delivery that already *completed*, or one another request is working on now.
 *
 * It is not correct for one that failed, or one whose request died mid-flight:
 * Shopify sees the 200 and stops, so that order and every answer waiting to
 * reconcile against it would be lost with no way back. Two cases are therefore
 * re-claimed:
 *   - a row annotated by `markWebhookFailed` (the handler threw), and
 *   - a row with no outcome that is older than INFLIGHT_STALE_MS (the process
 *     crashed or was recycled before it could record one).
 * Every downstream handler is idempotent, so redoing partial work is safe.
 */
export async function claimWebhook(params: {
  webhookId: string;
  topic: string;
  apiVersion: string | null;
}): Promise<ClaimResult> {
  try {
    await db.webhookEvent.create({
      data: {
        webhookId: params.webhookId,
        topic: params.topic,
        apiVersion: params.apiVersion,
        // shopId here is the FK to Shop.id; set when the delivery is marked processed.
        shopId: null,
        // The payload body is deliberately not persisted. Idempotency needs only
        // webhookId, and an orders/* payload embeds a full customer object
        // (name, email, phone, address) that this app has no use for.
        payloadJson: null,
      },
    });
    return { claimed: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await retryDb(() =>
      db.webhookEvent.findUnique({
        where: { webhookId: params.webhookId },
        select: { processedAt: true, error: true, createdAt: true },
      }),
    );

    if (!existing || existing.processedAt) {
      logger.info("webhook_duplicate_skipped", { webhook_id: params.webhookId, topic: params.topic });
      return { claimed: false };
    }

    const abandoned = Date.now() - existing.createdAt.getTime() > INFLIGHT_STALE_MS;
    if (!existing.error && !abandoned) {
      // Still being worked on by another request. Re-claiming would run the
      // handler twice in parallel, which is what insert-first exists to prevent.
      logger.info("webhook_duplicate_skipped", { webhook_id: params.webhookId, topic: params.topic });
      return { claimed: false };
    }

    logger.info("webhook_reclaimed", {
      webhook_id: params.webhookId,
      topic: params.topic,
      reason: existing.error ? "previous_attempt_failed" : "previous_attempt_abandoned",
    });
    return { claimed: true };
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "P2002";
}

export async function markWebhookProcessed(webhookId: string, internalShopId: string | null): Promise<void> {
  await retryDb(() =>
    db.webhookEvent.update({
      where: { webhookId },
      data: { processedAt: new Date(), shopId: internalShopId },
    }),
  );
}

export async function markWebhookFailed(webhookId: string, message: string): Promise<void> {
  await retryDb(() =>
    db.webhookEvent.update({
      where: { webhookId },
      data: { error: message.slice(0, 500) },
    }),
  );
}

/// The subset of the orders/* payload this app uses.
///
/// Customer fields (name, email, phone, address) are deliberately absent. They
/// are present in the webhook body, but nothing here reads them and nothing
/// downstream persists them.
///
/// `current_total_price` is the ONLY money field read. Shopify documents it as
/// reflecting order edits, returns and refunds, so it is already net. There is
/// deliberately no refund field: `total_refunded` is not a documented order
/// property, and subtracting any refund from `current_total_price` would deduct it
/// twice.
type ShopifyOrder = {
  id: number | string;
  name?: string | null;
  order_number?: number;
  currency: string;
  current_total_price?: string | null;
  financial_status?: string | null;
  test?: boolean;
  cancelled_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderWebhookResult =
  | { action: "orders_upserted"; shopInternalId: string; orderId: string; reconciled: number }
  | { action: "order_cancelled"; shopInternalId: string; orderId: string }
  | { action: "order_stale_ignored"; shopInternalId: string; orderId: string }
  | { action: "order_payload_invalid"; topic: string }
  | { action: "ignored_shop_not_installed"; topic: string }
  | { action: "app_uninstalled"; shopInternalId: string }
  | { action: "scopes_updated"; shopInternalId: string }
  | { action: "subscription_updated"; shopInternalId: string }
  | { action: "compliance_noop"; topic: string };

/**
 * Apply a verified webhook. Throws on unexpected failure so the route can return
 * 500 and let Shopify retry.
 */
export async function processWebhook(params: {
  topic: string;
  shopDomain: string;
  payload: Record<string, unknown>;
  accessToken: string | null;
}): Promise<OrderWebhookResult> {
  const { topic, shopDomain, payload, accessToken } = params;

  switch (topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/cancelled": {
      const shopInternalId = await resolveInstalledShop(shopDomain, accessToken);
      if (!shopInternalId) {
        // Unknown shop, or one that has uninstalled. Acknowledge and do nothing:
        // a webhook must never resurrect a shop.
        logger.info("webhook_ignored_shop_not_installed", { topic, shop_domain: shopDomain });
        return { action: "ignored_shop_not_installed", topic };
      }

      const outcome = await upsertOrderCache(
        shopInternalId,
        payload as unknown as ShopifyOrder,
        topic === "orders/cancelled",
      );

      if (!outcome) {
        logger.warn("order_payload_invalid", { topic, shop_id: shopInternalId });
        return { action: "order_payload_invalid", topic };
      }

      if (!outcome.applied) {
        logger.info("order_stale_delivery_ignored", {
          topic,
          shop_id: shopInternalId,
          order_id: outcome.orderId,
        });
        return { action: "order_stale_ignored", shopInternalId, orderId: outcome.orderId };
      }

      if (topic === "orders/cancelled") {
        return { action: "order_cancelled", shopInternalId, orderId: outcome.orderId };
      }

      return {
        action: "orders_upserted",
        shopInternalId,
        orderId: outcome.orderId,
        reconciled: outcome.reconciled,
      };
    }

    case "app/uninstalled": {
      // Sessions hold the access token in plaintext. They must not outlive the
      // installation, whether or not we still have a shop row.
      await retryDb(() => db.session.deleteMany({ where: { shop: shopDomain } }));

      const shop = await findShopByDomain(shopDomain);
      if (!shop) return { action: "app_uninstalled", shopInternalId: "" };
      // Data is RETAINED (see docs/03 FLOW 10). Only the credential is erased.
      await clearAccessToken(shop.id);
      logger.info("app_uninstalled", { shop_id: shop.id, shop_domain: shopDomain });
      return { action: "app_uninstalled", shopInternalId: shop.id };
    }

    case "app/scopes_update": {
      const shop = await findShopByDomain(shopDomain);
      if (!shop) return { action: "scopes_updated", shopInternalId: "" };
      logger.info("scopes_updated", { shop_id: shop.id, current: payload.current });
      return { action: "scopes_updated", shopInternalId: shop.id };
    }

    case "app_subscriptions/update": {
      const shop = await findShopByDomain(shopDomain);
      if (!shop) return { action: "subscription_updated", shopInternalId: "" };
      await applySubscription(shop.id, payload);
      return { action: "subscription_updated", shopInternalId: shop.id };
    }

    case "customers/data_request":
    case "customers/redact":
    case "shop/redact":
      // Handled in compliance.server.ts. Reaching here means no stored data
      // matched, which is a valid outcome to log.
      logger.info("compliance_webhook_no_match", { topic, shop_domain: shopDomain });
      return { action: "compliance_noop", topic };

    default:
      logger.info("webhook_unhandled_topic", { topic });
      return { action: "compliance_noop", topic };
  }
}

type ValidOrder = { orderId: string; createdAt: Date; updatedAt: Date; cancelledAt: Date | null };

/** Reject a payload we cannot store, instead of throwing on every Shopify retry. */
function readOrder(order: ShopifyOrder): ValidOrder | null {
  const idOk =
    (typeof order.id === "number" && Number.isSafeInteger(order.id) && order.id > 0) ||
    (typeof order.id === "string" && /^[0-9]+$/.test(order.id));
  if (!idOk) return null;
  if (typeof order.currency !== "string" || order.currency.trim() === "") return null;

  const createdAt = new Date(order.created_at);
  const updatedAt = new Date(order.updated_at);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) return null;

  const cancelledAt = order.cancelled_at ? new Date(order.cancelled_at) : null;
  if (cancelledAt && Number.isNaN(cancelledAt.getTime())) return null;

  return { orderId: String(order.id), createdAt, updatedAt, cancelledAt };
}

type OrderOutcome = { orderId: string; applied: boolean; reconciled: number };

/**
 * Write an order into the cache.
 *
 * The write is conditional on `updatedAtShop <= incoming updated_at`, so a stale
 * or replayed delivery changes nothing, and redelivery of the same event is a
 * harmless re-apply. If no row matched and none exists, the order is created; if
 * the create loses to an existing newer row, the delivery was stale.
 *
 * `totalPrice` is `current_total_price` (already net of refunds and edits). An
 * unparseable total is stored as NULL on a new row and never overwrites a good
 * stored total on an existing one; revenue then reads it as "unparseable" and the
 * answer stays Pending, rather than reporting a fabricated $0.00.
 */
async function upsertOrderCache(
  shopInternalId: string,
  order: ShopifyOrder,
  forceCancelled: boolean,
): Promise<OrderOutcome | null> {
  const valid = readOrder(order);
  if (!valid) return null;

  const { orderId, createdAt, updatedAt } = valid;
  // orders/cancelled means cancelled even if the payload omits cancelled_at.
  const cancelledAt = valid.cancelledAt ?? (forceCancelled ? updatedAt : null);

  const totalParsed = parseMoneyToMinor(order.current_total_price, order.currency);
  if (!totalParsed.ok) {
    logger.warn("order_total_unparseable", {
      shop_id: shopInternalId,
      order_id: orderId,
      reason: totalParsed.reason,
    });
  }
  // Built from integer minor units, never float division.
  const totalDecimal = totalParsed.ok ? minorToDecimalString(totalParsed.minor, order.currency) : null;

  const common = {
    orderNumber: order.name ?? (order.order_number ? String(order.order_number) : null),
    currency: order.currency,
    financialStatus: order.financial_status ?? null,
    isTest: order.test === true,
    isCancelled: cancelledAt !== null,
    cancelledAt,
    updatedAtShop: updatedAt,
  };

  const updated = await retryDb(() =>
    db.orderCache.updateMany({
      where: { shopId: shopInternalId, orderId, updatedAtShop: { lte: updatedAt } },
      data: totalDecimal === null ? common : { ...common, totalPrice: totalDecimal },
    }),
  );

  let applied = updated.count > 0;

  if (!applied) {
    try {
      await retryDb(() =>
        db.orderCache.create({
          data: { shopId: shopInternalId, orderId, ...common, totalPrice: totalDecimal, createdAtShop: createdAt },
        }),
      );
      applied = true;
    } catch (error) {
      // The row exists with a newer updatedAtShop: this delivery is stale.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (!applied) return { orderId, applied: false, reconciled: 0 };

  // Reconcile only from a total we actually parsed. Idempotent: only rows still
  // unreconciled change.
  if (totalDecimal === null) return { orderId, applied: true, reconciled: 0 };

  const { reconciled } = await reconcileResponsesForOrder({
    shopId: shopInternalId,
    orderId,
    currency: order.currency,
    totalPrice: totalDecimal,
  });

  return { orderId, applied: true, reconciled };
}

type SubscriptionPayload = {
  admin_graphql_api_id?: string;
  name?: string;
  status?: string;
  test?: boolean;
};

/**
 * Map a billing webhook onto a local plan.
 *
 * Only a subscription whose `name` matches one of our display names counts,
 * so an unrelated subscription on the same shop cannot grant SourceTrac a
 * paid plan.
 */
async function applySubscription(shopInternalId: string, payload: SubscriptionPayload): Promise<void> {
  const status = (payload.status ?? "").toUpperCase();
  const gid = payload.admin_graphql_api_id ?? null;
  const displayName = payload.name ?? null;

  const matched = matchPlanByDisplayName(displayName);

  if (!matched) {
    // Not a SourceTrac subscription, or a test charge. Leave the plan alone.
    logger.info("subscription_unmatched", { shop_id: shopInternalId, name: displayName, status });
    return;
  }

  const planStatus = normaliseSubscriptionStatus(status);

  // Changing plan creates a new subscription and Shopify cancels the old one,
  // so the old charge's CANCELLED notice can land after the new one went
  // ACTIVE. Applying it would drop a merchant who just paid back to free. A
  // non-active status only applies to the subscription we currently hold.
  if (planStatus !== "active") {
    const shop = await findShopById(shopInternalId);
    if (shop?.subscriptionGid && gid && shop.subscriptionGid !== gid) {
      logger.info("subscription_superseded_ignored", { shop_id: shopInternalId, status: planStatus });
      return;
    }
  }

  await setPlan(shopInternalId, {
    plan: matched.key,
    planStatus,
    subscriptionGid: gid,
    planDisplayName: displayName,
  });

  logger.info("subscription_applied", { shop_id: shopInternalId, plan: matched.key, status: planStatus });
}

export function matchPlanByDisplayName(name: string | null): { key: PlanKey } | null {
  if (!name) return null;
  const normalised = name.toLowerCase();
  if (!normalised.startsWith("sourcetrac")) return null;

  if (normalised.includes("growth")) return { key: "growth" };
  if (normalised.includes("scale")) return { key: "scale" };
  if (normalised.includes("free")) return { key: "free" };
  return null;
}

/**
 * Shopify subscription statuses we model. Anything unrecognised is treated as
 * expired: we never grant paid access on a status we cannot verify.
 */
export function normaliseSubscriptionStatus(status: string): PlanStatus {
  switch (status.toLowerCase()) {
    case "active":
      return "active";
    case "cancelled":
      return "cancelled";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "frozen":
    case "pending":
      return "frozen";
    default:
      return "expired";
  }
}

export { isPlanKey };
