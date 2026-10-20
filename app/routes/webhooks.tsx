import { logger } from "~/lib/logger";
import {
  handleCustomerRedact,
  handleDataRequest,
  handleShopRedact,
  maybeRunAllPendingDeletions,
} from "~/lib/compliance.server";
import {
  claimWebhook,
  markWebhookFailed,
  markWebhookProcessed,
  normaliseWebhookTopic,
  processWebhook,
} from "~/lib/webhooks.server";
import { maybeRunRetention } from "~/lib/retention.server";
import { findShopByDomain, getAccessToken } from "~/lib/shop.server";
import { authenticateWebhook } from "~/shopify.server";

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

  // Verifies HMAC, then parses. A tampered body never reaches our handler. No
  // session is loaded or refreshed here (see `authenticateWebhook`).
  const verified = await authenticateWebhook(request);
  const { webhookId, shop, payload } = verified;
  // The library upper-cases the topic (`ORDERS_CREATE`); handlers use Shopify's
  // spelling (`orders/create`). See `normaliseWebhookTopic`.
  const topic = normaliseWebhookTopic(verified.topic);

  logger.info("webhook_received", {
    request_id: requestId,
    topic,
    shop_domain: shop,
    webhook_id: webhookId,
  });

  // Shopify's delivery time, to order two updates within one second of
  // `updated_at` (and to tell a late uninstall from a reinstall).
  const triggeredHeader = request.headers.get("X-Shopify-Triggered-At");
  const triggeredAtParsed = triggeredHeader ? new Date(triggeredHeader) : null;
  const triggeredAt = triggeredAtParsed && !Number.isNaN(triggeredAtParsed.getTime()) ? triggeredAtParsed : null;

  let claim: Awaited<ReturnType<typeof claimWebhook>>;
  try {
    claim = await claimWebhook({
      webhookId,
      topic,
      apiVersion: verified.apiVersion ?? null,
    });
  } catch (error) {
    // The ledger is unreachable (typically Neon waking). Nothing was done, so
    // a logged 500 lets Shopify retry the whole delivery.
    logger.error("webhook_claim_failed", {
      request_id: requestId,
      topic,
      webhook_id: webhookId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: "processing_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!claim.claimed && claim.inFlight) {
    // Another request is still working on this delivery (typically Shopify's
    // timeout retry landing during a cold start). A 200 here would end Shopify's
    // retries, so if that first attempt then fails the order is lost for good.
    // 503 keeps Shopify retrying; the next attempt finds it processed (200) or
    // failed (re-claimed and redone).
    logger.info("webhook_in_flight_retry_later", { request_id: requestId, topic, webhook_id: webhookId });
    return new Response(JSON.stringify({ received: false, in_flight: true }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  if (!claim.claimed) {
    logger.info("webhook_duplicate_skipped", { request_id: requestId, topic, webhook_id: webhookId });
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (COMPLIANCE_TOPICS.has(topic)) {
      await handleCompliance(topic, shop, payload, webhookId, triggeredAt);
      await markWebhookProcessed(webhookId, null);
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only billing notices call Shopify. Resolving a token for every order
    // delivery cost a lookup (and possibly a refresh) inside Shopify's
    // five-second budget for nothing.
    const accessToken = topic === "app_subscriptions/update" ? await getAccessTokenForShop(shop) : null;

    const result = await processWebhook({ topic, shopDomain: shop, payload, accessToken, triggeredAt });

    const shopInternalId = "shopInternalId" in result ? result.shopInternalId : null;
    await markWebhookProcessed(webhookId, shopInternalId || null);
    logger.info("webhook_processed", { request_id: requestId, topic, action: result.action });

    // Fire-and-forget daily purge, and any deferred redact still queued for any
    // shop; the database is already awake here.
    void maybeRunRetention();
    void maybeRunAllPendingDeletions();

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

    await markWebhookFailed(webhookId, error instanceof Error ? error.message : String(error)).catch(
      (markError: unknown) => {
        // Never let a bookkeeping failure mask the original error, but do not
        // lose it either: an unmarked row is only re-claimed once it is stale.
        logger.warn("webhook_mark_failed_failed", {
          request_id: requestId,
          webhook_id: webhookId,
          error_message: markError instanceof Error ? markError.message : String(markError),
        });
      },
    );

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

async function handleCompliance(
  topic: string,
  shopDomain: string,
  payload: Record<string, unknown>,
  webhookId: string,
  triggeredAt: Date | null,
): Promise<void> {
  if (topic === "customers/data_request") {
    const customer = (payload.customer ?? {}) as Record<string, unknown>;
    await handleDataRequest({
      shopDomain,
      customerEmail: asString(customer.email) ?? asString(payload.email),
      customerPhone: asString(customer.phone) ?? asString(payload.phone),
      // The customer's orders, which is how their answers are found.
      orderIds: numericIds(payload.orders_requested),
      webhookId,
    });
    return;
  }

  if (topic === "customers/redact") {
    // `orders_to_redact` is the whole point of this webhook. It is an array of
    // numeric order IDs; the identifiers inside the payload cannot match our
    // rows because we store none of them.
    await handleCustomerRedact({ shopDomain, orderIds: numericIds(payload.orders_to_redact), webhookId });
    return;
  }

  await handleShopRedact({ shopDomain, triggeredAt });
}

/** A payload array of numeric order ids, as strings. */
function numericIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v : null))
    .filter((v): v is string => v !== null && /^\d+$/.test(v));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const loader = async () =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });