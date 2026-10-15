import { ApiVersion, shopifyApp } from "@shopify/shopify-app-react-router/server";

import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { provisionShop } from "~/lib/provision.server";
import { sessionStorage } from "~/session-storage.server";

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
