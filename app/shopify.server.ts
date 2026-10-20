import { ApiVersion, shopifyApp } from "@shopify/shopify-app-react-router/server";

import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { provisionShop } from "~/lib/provision.server";
import { migrateToExpiringToken } from "~/lib/token-migration.server";
import { sessionStorage } from "~/session-storage.server";

// A session stored before expiring tokens holds a token Shopify refuses; it is
// exchanged for an expiring one the first time it is loaded.
sessionStorage.useLegacyTokenMigration(migrateToExpiringToken);

/**
 * Shopify app wiring.
 *
 * Uses the official `shopifyApp()` wrapper rather than the lower-level
 * `shopifyApi()`. The wrapper owns OAuth, session-token verification, CORS and
 * webhook HMAC — all of which we would otherwise hand-roll and get subtly
 * wrong. `authenticate.public.checkout()` is what the extension endpoints use.
 */
const shopify = shopifyApp({
  apiKey: env().SHOPIFY_API_KEY,
  apiSecretKey: env().SHOPIFY_API_SECRET,
  apiVersion: env().SHOPIFY_API_VERSION as ApiVersion,
  scopes: env().SCOPES.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean),
  appUrl: env().APP_URL,
  authPathPrefix: "/auth",
  sessionStorage,
  // Shopify refuses non-expiring offline tokens on the Admin API ("403
  // Non-expiring access tokens are no longer accepted"), so every Admin call,
  // billing included, failed. With this flag token exchange asks for an
  // expiring token plus a refresh token, and the library refreshes it before
  // it lapses in `authenticate.*` and `unauthenticated.admin`.
  future: { expiringOfflineAccessTokens: true },
  hooks: {
    // Token-exchange installs never hit /auth/callback, so create the shops row here.
    afterAuth: async ({ session }) => {
      // Never fail the merchant's auth over our own bookkeeping: the admin
      // loaders call `ensureShop`, which provisions on the next request.
      try {
        await provisionShop(session);
      } catch (error) {
        logger.error("after_auth_provision_failed", {
          shop_domain: session.shop,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  },
});

export const { addDocumentResponseHeaders, authenticate, login, registerWebhooks, unauthenticated } = shopify;
export default shopify;

/**
 * Webhook verification only, by the library's own `authenticate.webhook`, on an
 * instance whose session storage holds nothing.
 *
 * The main instance loads the offline session on every delivery and, with
 * expiring tokens, refreshes it first; a refused or failed refresh throws
 * before our handler runs. After an uninstall Shopify refuses that refresh, so
 * `app/uninstalled`, `shop/redact` and the customer redactions answered 500 on
 * every retry and were never applied. No handler needs the library's session:
 * the one that needs a token (`app_subscriptions/update`) fetches it itself.
 */
const noSessions = {
  storeSession: async () => true,
  loadSession: async () => undefined,
  deleteSession: async () => true,
  deleteSessions: async () => true,
  findSessionsByShop: async () => [],
  isReady: async () => true,
};

const webhookVerifier = shopifyApp({
  apiKey: env().SHOPIFY_API_KEY,
  apiSecretKey: env().SHOPIFY_API_SECRET,
  apiVersion: env().SHOPIFY_API_VERSION as ApiVersion,
  scopes: env().SCOPES.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean),
  appUrl: env().APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: noSessions as unknown as typeof sessionStorage,
  future: { expiringOfflineAccessTokens: true },
});

export const authenticateWebhook = webhookVerifier.authenticate.webhook;
