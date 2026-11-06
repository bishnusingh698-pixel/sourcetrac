import crypto from "node:crypto";

import { Session } from "@shopify/shopify-api";

import { sessionStorage } from "~/session-storage.server";

/**
 * Drive an embedded-admin loader or action the way App Bridge calls it: a
 * `fetch` carrying `Authorization: Bearer <id token>` signed with the app
 * secret, a browser User-Agent, and an offline session already in storage so
 * the library's own `authenticate.admin` runs for real without a token
 * exchange. Only Shopify's Admin API is stubbed (at `fetch`) by the caller.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export function adminIdToken(shopDomain: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: `https://${shopDomain}/admin`,
    dest: `https://${shopDomain}`,
    aud: process.env.SHOPIFY_API_KEY,
    sub: "1",
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    jti: crypto.randomUUID(),
    sid: crypto.randomUUID(),
  });
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Store a live offline session, as token exchange would have. */
export async function seedOfflineSession(shopDomain: string, accessToken = "shpat_test_token"): Promise<void> {
  const session = new Session({
    id: `offline_${shopDomain}`,
    shop: shopDomain,
    state: "",
    isOnline: false,
    scope: process.env.SCOPES,
    accessToken,
    expires: new Date(Date.now() + 60 * 60 * 1000),
  });
  session.refreshToken = "shprt_test_refresh";
  session.refreshTokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sessionStorage.storeSession(session);
}

export function adminRequest(shopDomain: string, path: string, init: RequestInit = {}): Request {
  const url = new URL(path, process.env.APP_URL ?? "https://sourcetrac.example.com");
  if (!url.searchParams.has("shop")) url.searchParams.set("shop", shopDomain);
  return new Request(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminIdToken(shopDomain)}`,
      "User-Agent": UA,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** A form POST to an admin action. */
export function adminForm(shopDomain: string, path: string, fields: Record<string, string>): Request {
  return adminRequest(shopDomain, path, { method: "POST", body: new URLSearchParams(fields) });
}

/** Run a loader/action, unwrapping a thrown Response so a test can read it. */
export async function runRoute<T>(
  handler: (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<T> | T,
  request: Request,
  params: Record<string, string> = {},
): Promise<T> {
  return handler({ request, params, context: {} }) as Promise<T>;
}
