import type { PlanStatus } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { parseMoneyToMinor } from "~/lib/money";
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
 * Two invariants:
 *   1. HMAC is verified by the route before anything here runs.
 *   2. X-Shopify-Webhook-Id is inserted into webhook_events with a unique
 *      constraint BEFORE any business logic. A concurrent or repeated delivery
 *      loses that insert and returns 200 immediately. That makes retries safe
 *      and out-of-order delivery harmless without a distributed lock.
 */

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

/** Stripe the shop's token on the first order webhook for an offline install. */
export async function ensureShopAndToken(shopDomain: string, accessToken: string | null): Promise<string> {
  const existing = await findShopByDomain(shopDomain);
  const { id } = await upsertShop({
    shopDomain,
    shopId: shopDomain,
    accessToken: accessToken ?? null,
  });

  // Only look up the plan when we just gained a token, so we do not hit the
  // Admin API on every single webhook.
  if (!existing || !existing.checkoutSupported) {
    void refreshCheckoutSupport(id).catch((error: unknown) => {
      logger.warn("checkout_support_refresh_failed", {
        shop_id: id,
        error_message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return id;
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

/**
 * Claim a webhook delivery.
 *
 * Insert-first, so a concurrent or repeated delivery loses the insert and is
 * refused — the caller returns 200 and Shopify stops retrying. That is correct for
 * a delivery that already *completed*.
 *
 * It is not correct for one that failed. A row left behind by a throw is
 * annotated by `markWebhookFailed`, and refusing its retry would make a transient
 * fault permanent: Shopify sees the 200 and stops, so that order — and every
 * answer waiting to reconcile against it — is lost with no way back. A failed row
 * is therefore re-claimed and its partial work redone, which is what this
 * module's stated idempotency contract ("a retry can redo partial work")
 * requires. Every downstream handler is written to be idempotent.
 */
export async function claimWebhook(params: {
  webhookId: string;
  topic: string;
  apiVersion: string | null;
  payload: string;
}): Promise<ClaimResult> {
  try {
    await db.webhookEvent.create({
      data: {
        webhookId: params.webhookId,
        topic: params.topic,
        apiVersion: params.apiVersion,
        // shopId here is the FK to Shop.id; resolved by the caller before insert.
        shopId: null,
        payloadJson: params.payload.slice(0, 20_000),
      },
    });
    return { claimed: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Lost the insert: this delivery id is already in the ledger. Re-claim only a
    // delivery that we have already recorded as failed.
    //
    // Keyed on `error` rather than on `processedAt` alone. A row with no
    // `processedAt` and no error is a delivery that is still in flight, and
    // re-claiming that would let a concurrent duplicate run the handler a second
    // time alongside the original. `markWebhookFailed` is what distinguishes "we
    // tried this and it broke" from "we are still working on it".
    const existing = await retryDb(() =>
      db.webhookEvent.findUnique({
        where: { webhookId: params.webhookId },
        select: { processedAt: true, error: true },
      }),
    );

    if (!existing?.error || existing.processedAt) {
      logger.info("webhook_duplicate_skipped", { webhook_id: params.webhookId, topic: params.topic });
      return { claimed: false };
    }

    logger.info("webhook_reclaimed_after_failure", { webhook_id: params.webhookId, topic: params.topic });
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

type ShopifyOrder = {
  id: number;
  name?: string | null;
  order_number?: number;
  email?: string;
  contact_email?: string;
  currency: string;
  current_total_price: string;
  total_price: string;
  total_refunded: string;
  financial_status: string | null;
  test?: boolean;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderWebhookResult =
  | { action: "orders_upserted"; shopInternalId: string; orderId: string; reconciled: number }
  | { action: "order_cancelled"; shopInternalId: string; orderId: string }
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
    case "orders/updated": {
      const order = payload as unknown as ShopifyOrder;
      const shopInternalId = await ensureShopAndToken(shopDomain, accessToken);
      const reconciled = await upsertOrderCache(shopInternalId, order);
      return { action: "orders_upserted", shopInternalId, orderId: String(order.id), reconciled };
    }

    case "orders/cancelled": {
      const order = payload as unknown as ShopifyOrder;
      const shop = await findShopByDomain(shopDomain);
      if (!shop) {
        // The shop was uninstalled before the cancel arrived. Nothing to update.
        logger.info("webhook_shop_gone", { topic, shop_domain: shopDomain });
        return { action: "order_cancelled", shopInternalId: "", orderId: String(order.id) };
      }

      await retryDb(() =>
        db.orderCache.update({
          where: { shopId_orderId: { shopId: shop.id, orderId: String(order.id) } },
          data: { isCancelled: true, cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : new Date() },
        }).catch((error: unknown) => {
          // P2025 = row not found: the order was never cached (merchant's first
          // webhook was the cancel). That is normal, not an error.
          if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2025") return null;
          throw error;
        }),
      );

      return { action: "order_cancelled", shopInternalId: shop.id, orderId: String(order.id) };
    }

    case "app/uninstalled": {
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

async function upsertOrderCache(shopInternalId: string, order: ShopifyOrder): Promise<number> {
  const orderId = String(order.id);

  const totalParsed = parseMoneyToMinor(order.current_total_price ?? order.total_price, order.currency);
  if (!totalParsed.ok) {
    logger.warn("order_total_unparseable", {
      shop_id: shopInternalId,
      order_id: orderId,
      reason: totalParsed.reason,
    });
  }

  const refundedParsed = parseMoneyToMinor(order.total_refunded ?? 0, order.currency);
  // `OrderCache.totalPrice` is NOT NULL, so an unparseable total still has to be
  // written as something. "0.00" is the only value that cannot be mistaken for
  // real revenue, and it is safe here *because* reconciliation is skipped below.
  const totalDecimal = totalParsed.ok
    ? (totalParsed.minor / 10 ** totalParsed.decimals).toFixed(totalParsed.decimals)
    : "0.00";
  const refundedDecimal = refundedParsed.ok
    ? Math.abs(refundedParsed.minor / 10 ** refundedParsed.decimals).toFixed(refundedParsed.decimals)
    : "0.00";

  const cancelledAt = order.cancelled_at ? new Date(order.cancelled_at) : null;

  await retryDb(() =>
    db.orderCache.upsert({
      where: { shopId_orderId: { shopId: shopInternalId, orderId } },
      create: {
        shopId: shopInternalId,
        orderId,
        orderNumber: order.name ?? (order.order_number ? String(order.order_number) : null),
        currency: order.currency,
        totalPrice: totalDecimal,
        totalRefunded: refundedDecimal,
        financialStatus: order.financial_status,
        isTest: order.test === true,
        isCancelled: cancelledAt !== null,
        cancelledAt,
        createdAtShop: new Date(order.created_at),
        updatedAtShop: new Date(order.updated_at),
      },
      update: {
        orderNumber: order.name ?? null,
        currency: order.currency,
        totalPrice: totalDecimal,
        totalRefunded: refundedDecimal,
        financialStatus: order.financial_status,
        isTest: order.test === true,
        isCancelled: cancelledAt !== null,
        cancelledAt,
        updatedAtShop: new Date(order.updated_at),
      },
    }),
  );

  // Reconcile only from a total we actually parsed. Passing the "0.00" fallback
  // through would parse cleanly and stamp every waiting response with a zero
  // order total: the answer would silently stop counting as revenue, and the
  // merchant would see a real order reported at $0.00 with no way to tell that
  // apart from a genuine free order. Staying unreconciled is the honest state —
  // the dashboard already renders it as "Pending".
  if (!totalParsed.ok) {
    return 0;
  }

  // Idempotent and safe to run repeatedly: only rows still unreconciled change.
  const { reconciled } = await reconcileResponsesForOrder({
    shopId: shopInternalId,
    orderId,
    currency: order.currency,
    totalPrice: totalDecimal,
  });

  return reconciled;
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
