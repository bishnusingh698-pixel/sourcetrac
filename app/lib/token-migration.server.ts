import { Session } from "@shopify/shopify-api";

import { env } from "~/lib/env";

/**
 * Trade a non-expiring offline token for an expiring one.
 *
 * Shopify refuses non-expiring offline tokens on the Admin API ("403
 * Non-expiring access tokens are no longer accepted"). A session stored before
 * the app asked for expiring tokens holds one, and the library treats a session
 * with no expiry as valid forever, so it would never replace it. This is the
 * same token-exchange request `@shopify/shopify-api`'s `migrateToExpiringToken`
 * sends; `shopifyApp()` does not expose that client, so it is made here.
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
 */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

type TokenResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

export async function migrateToExpiringToken(legacy: Session): Promise<Session> {
  if (!SHOP_DOMAIN.test(legacy.shop)) throw new Error(`Not a shop domain: ${legacy.shop}`);
  if (!legacy.accessToken) throw new Error("The session has no token to migrate.");

  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET } = env();
  const response = await fetch(`https://${legacy.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: legacy.accessToken,
      subject_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: "1",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Shopify returned ${response.status} migrating the token: ${body.slice(0, 200)}`);
  }
  return sessionFromTokenResponse(legacy, (await response.json()) as TokenResponse);
}

/** The expiring session, under the legacy session's id so it replaces that row. */
export function sessionFromTokenResponse(legacy: Session, body: TokenResponse, now = Date.now()): Session {
  if (!body.access_token || !body.expires_in) throw new Error("Shopify returned no expiring token.");
  const session = new Session({ id: legacy.id, shop: legacy.shop, state: "", isOnline: false });
  session.accessToken = body.access_token;
  session.scope = body.scope ?? legacy.scope;
  session.expires = new Date(now + body.expires_in * 1000);
  if (body.refresh_token) {
    session.refreshToken = body.refresh_token;
    if (body.refresh_token_expires_in) {
      session.refreshTokenExpires = new Date(now + body.refresh_token_expires_in * 1000);
    }
  }
  return session;
}
