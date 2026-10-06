import { logger } from "~/lib/logger";
import { handleCustomerRedact, handleDataRequest, handleShopRedact } from "~/lib/compliance.server";
import { claimWebhook, markWebhookFailed, markWebhookProcessed, processWebhook } from "~/lib/webhooks.server";
import { maybeRunRetention } from "~/lib/retention.server";
import { findShopByDomain, getAccessToken } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * POST /webhooks
 *
 * `authenticate.webhook(request)` verifies the HMAC over the raw body and
 * returns already-parsed fields, so we never re-implement signature checking.
 *
 * Idempotency is layered on top: we insert `webhookId` into `webhook_events`
 * with a unique constraint BEFORE processing. A repeat of an already-completed
 * delivery loses that insert and returns 200 immediately, so Shopify stops
 * retrying. A delivery that previously *failed* is re-claimed instead, so a
 * transient fault is retried rather than permanently dropped.
 */

/** Topics that must never fail — Shopify treats a non-2xx as a failed action. */
const COMPLIANCE_TOPICS = new Set(["customers/data_request", "customers/redact", "shop/redact"]);

export const action = async ({ request }: { request: Request }) => {
  const requestId = `wh_${Date.now().toString(36)}`;

  // Verifies HMAC, then parses. A tampered body never reaches our handler.
  const { webhookId, topic, shop, payload, session } = await authenticate.webhook(request);

  logger.info("webhook_received", {
    request_id: requestId,
    topic,
    shop_domain: shop,
    webhook_id: webhookId,
    has_session: Boolean(session),
  });

  const claim = await claimWebhook({
    webhookId,
    topic,
    apiVersion: null,
  });

  if (!claim.claimed) {
    logger.info("webhook_duplicate_skipped", { request_id: requestId, topic, webhook_id: webhookId });
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (COMPLIANCE_TOPICS.has(topic)) {
      await handleCompliance(topic, shop, payload);
      await markWebhookProcessed(webhookId, null);
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // `session` is undefined when the webhook arrives after an uninstall.
    // Falling back to the encrypted token covers the cold-start case, where no
    // session row is loaded but we still hold a valid credential.
    const accessToken = session?.accessToken ?? (await getAccessTokenForShop(shop));

    const result = await processWebhook({ topic, shopDomain: shop, payload, accessToken });

    const shopInternalId = "shopInternalId" in result ? result.shopInternalId : null;
    await markWebhookProcessed(webhookId, shopInternalId || null);
    logger.info("webhook_processed", { request_id: requestId, topic, action: result.action });

    // Fire-and-forget daily purge; the database is already awake here.
    void maybeRunRetention();

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Returning 500 asks Shopify to retry, which is correct for a transient
    // database or network fault. markWebhookFailed keeps the error for triage.
    logger.error("webhook_failed_retrying", {
      request_id: requestId,
      topic,
      webhook_id: webhookId,
      error_message: error instanceof Error ? error.message : String(error),
    });

    await markWebhookFailed(webhookId, error instanceof Error ? error.message : String(error)).catch(() => {
      // Never let a bookkeeping failure mask the original error.
    });

    return new Response(JSON.stringify({ error: "processing_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

/**
 * Resolve the internal shop id for the token fallback. Kept in a helper so the
 * route body stays readable and the failure mode is obvious: a missing shop
 * simply yields a null token.
 */
async function getAccessTokenForShop(shopDomain: string): Promise<string | null> {
  const record = await findShopByDomain(shopDomain);
  if (!record) return null;
  return getAccessToken(record.id);
}

async function handleCompliance(topic: string, shopDomain: string, payload: Record<string, unknown>): Promise<void> {
  if (topic === "customers/data_request") {
    const customer = (payload.customer ?? {}) as Record<string, unknown>;
    await handleDataRequest({
      shopDomain,
      customerEmail: asString(customer.email) ?? asString(payload.email),
      customerPhone: asString(customer.phone) ?? asString(payload.phone),
    });
    return;
  }

  if (topic === "customers/redact") {
    // `orders_to_redact` is the whole point of this webhook. It is an array of
    // numeric order IDs; the identifiers inside the payload cannot match our
    // rows because we store none of them.
    const raw = Array.isArray(payload.orders_to_redact) ? payload.orders_to_redact : [];
    const orderIds = raw
      .map((v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v : null))
      .filter((v): v is string => v !== null && /^\d+$/.test(v));
    await handleCustomerRedact({ shopDomain, orderIds });
    return;
  }

  await handleShopRedact({ shopDomain });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const loader = async () =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });