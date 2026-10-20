import crypto from "node:crypto";

import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { authenticate } from "~/shopify.server";

/**
 * `authenticate.public.checkout` for the checkout/customer-account blocks, with
 * the two things the library leaves out.
 *
 * 1. CORS on a refusal. The library throws a bare `401` when the session token
 *    is missing or does not verify, with no `Access-Control-Allow-Origin`. The
 *    block runs in a Web Worker on another origin, so the browser hides that
 *    response and `fetch` rejects as if the network failed. The block then
 *    retried a request that could never succeed for a full minute on
 *    "Loading…" before disappearing, and our logs said nothing: the library
 *    only logs the reason at debug level. Now the 401 is readable (the block
 *    stops at once) and the reason is logged as a warning.
 *
 * 2. The shop domain, normalised. Checkout tokens carry the bare
 *    `store.myshopify.com` in `dest`; admin tokens carry a URL. A URL here
 *    would look up no shop and hide the survey on every order, so both forms
 *    are reduced to the domain.
 */

export type CheckoutAuth = Awaited<ReturnType<typeof authenticate.public.checkout>> & { shopDomain: string };

/** `https://Store.myshopify.com/` -> `store.myshopify.com`. */
export function shopDomainFromDest(dest: string): string {
  return dest
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** Why a session token was refused, for the log line. Never decides anything. */
export function classifyRejectedToken(header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): {
  reason: "no_token" | "malformed" | "bad_signature" | "expired" | "not_yet_valid" | "other";
  dest: string | null;
} {
  const token = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token) return { reason: "no_token", dest: null };
  const parts = token.split(".");
  if (parts.length !== 3) return { reason: "malformed", dest: null };
  let payload: { dest?: unknown; exp?: unknown; nbf?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof payload;
  } catch {
    return { reason: "malformed", dest: null };
  }
  // Unverified, so only ever logged: it tells an operator which store's blocks
  // are failing, and a bad signature for a store we know means the deployed
  // SHOPIFY_API_SECRET is not this app's secret.
  const dest = typeof payload.dest === "string" ? shopDomainFromDest(payload.dest).slice(0, 255) : null;
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const given = Buffer.from(parts[2]!);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return { reason: "bad_signature", dest };
  // The library allows ten seconds of clock skew either way.
  if (typeof payload.exp === "number" && payload.exp + 10 < nowSeconds) return { reason: "expired", dest };
  if (typeof payload.nbf === "number" && payload.nbf - 10 > nowSeconds) return { reason: "not_yet_valid", dest };
  return { reason: "other", dest };
}

export async function authenticateCheckout(request: Request, route: string): Promise<CheckoutAuth> {
  try {
    const auth = await authenticate.public.checkout(request);
    return { ...auth, shopDomain: shopDomainFromDest(String(auth.sessionToken.dest ?? "")) };
  } catch (thrown) {
    if (!(thrown instanceof Response) || thrown.status < 400) throw thrown;
    if (thrown.status === 410) {
      // The library's bot filter. A buyer whose browser it misreads as a bot
      // must still get a readable answer: without CORS the block saw a network
      // error and retried the same refusal for a minute.
      const headers = new Headers(thrown.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Content-Type", "application/json");
      throw new Response(JSON.stringify({ error: { code: "bot_blocked" } }), { status: 410, headers });
    }
    const { reason, dest } = classifyRejectedToken(request.headers.get("Authorization"), env().SHOPIFY_API_SECRET);
    logger.warn("checkout_auth_rejected", {
      route,
      status: thrown.status,
      reason,
      token_dest_unverified: dest,
      has_origin: Boolean(request.headers.get("Origin")),
    });
    const headers = new Headers(thrown.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Content-Type", "application/json");
    throw new Response(JSON.stringify({ error: { code: "unauthorized", reason } }), {
      status: thrown.status,
      headers,
    });
  }
}
