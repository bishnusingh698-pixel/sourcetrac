import { z } from "zod";

import { lookupByCustomer, lookupByOrder } from "~/lib/admin-survey-context.server";
import { IdTokenError, verifyIdToken } from "~/lib/id-token.server";
import { logger } from "~/lib/logger";
import { getAccessToken, findShopByDomain } from "~/lib/shop.server";

/**
 * POST /api/admin-survey-context
 *
 * The admin block extensions (order details, customer details) call this to show
 * the merchant what the buyer answered.
 *
 * Auth is an OpenID Connect ID token minted by App Bridge, sent as
 * `Authorization: Bearer <jwt>` and verified in app/lib/id-token.server.ts. The
 * shop identity is the token's `dest` claim, never the `shop` in the body. The
 * order/customer id in the body is only a lookup key.
 *
 * A single POST with no `orders/*` write keeps this off the protected-customer-
 * data radar: we read order ids for a customer via `read_orders` (already held)
 * and never expose PII.
 */

const bodySchema = z
  .object({
    orderId: z.string().regex(/^\d+$/).max(20).nullish(),
    customerId: z.string().min(1).max(64).nullish(),
  })
  .refine((value) => Boolean(value.orderId) || Boolean(value.customerId), {
    message: "An orderId or customerId is required.",
  });

function corsHeaders(init: ResponseInit = {}): ResponseInit {
  const headers = new Headers(init.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { ...init, headers };
}

export const loader = async () => {
  // Preflight, and a cheap health probe. The browser sends OPTIONS to the
  // loader, so answering it here with CORS is what lets the POST through.
  return new Response(null, corsHeaders({ status: 204 }));
};

export const action = async ({ request }: { request: Request }) => {
  const requestId = `adm_${Date.now().toString(36)}`;

  try {
    if (request.method !== "POST") {
      return new Response("Method not allowed", corsHeaders({ status: 405 }));
    }

    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new IdTokenError("Missing ID token");

    const claims = verifyIdToken(token);
    const shop = await findShopByDomain(claims.dest);
    if (!shop || shop.installState === "uninstalled") {
      return new Response(JSON.stringify({ found: false }), corsHeaders());
    }

    const body = (await request.json().catch(() => ({}))) as unknown;
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ found: false }), corsHeaders());
    }

    if (parsed.data.orderId) {
      const result = await lookupByOrder(shop.id, parsed.data.orderId);
      return new Response(JSON.stringify(result), corsHeaders());
    }

    const accessToken = await getAccessToken(shop.id);
    if (!accessToken) {
      return new Response(JSON.stringify({ found: false }), corsHeaders());
    }
    const result = await lookupByCustomer({
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      accessToken,
      customerGid: parsed.data.customerId!,
    });
    return new Response(JSON.stringify(result), corsHeaders());
  } catch (error) {
    if (error instanceof IdTokenError) {
      logger.warn("admin_survey_context_auth_failed", { request_id: requestId, reason: error.message });
      return new Response(JSON.stringify({ found: false, error: "unauthorized" }), corsHeaders({ status: 401 }));
    }
    logger.error("admin_survey_context_failed", {
      request_id: requestId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    // Always a valid CORS body, even on failure: the block shows "no answer"
    // rather than an opaque network error.
    return new Response(JSON.stringify({ found: false }), corsHeaders({ status: 200 }));
  }
};
