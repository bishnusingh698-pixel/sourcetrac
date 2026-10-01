import { ApiVersion, shopifyApp } from "@shopify/shopify-app-react-router/server";

import { env } from "~/lib/env";
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
});

export const { addDocumentResponseHeaders, authenticate, registerWebhooks, unauthenticated } = shopify;
export default shopify;
