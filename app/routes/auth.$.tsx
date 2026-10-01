import { redirect } from "react-router";

import { logger } from "~/lib/logger";
import { checkoutSurfacesSupported, fetchShopIdentity, fetchShopPlanName } from "~/lib/shopify-rest.server";
import { findShopByDomain, setCheckoutSupport, upsertShop } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * OAuth entry and callback (`/auth/*`).
 *
 * `authPathPrefix: "/auth"` in shopify.server.ts means the official wrapper owns
 * the whole flow: it redirects to Shopify for consent, verifies the callback
 * HMAC, and exchanges the code for an access token. We never touch the token
 * exchange ourselves.
 *
 * On success we take that moment to make sure our own `shops` row exists,
 * because every public endpoint resolves the merchant through
 * `findShopByDomain`. Without this, the extension would silently report
 * `not_installed` on a correctly installed store.
 */
export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);

  // authenticate.admin both starts and completes OAuth, then returns the
  // context. Throwing a Response is how it signals "go to Shopify" or "session
  // expired, re-auth", so that throw must propagate untouched.
  const { session } = await authenticate.admin(request);

  const shopDomain = session.shop;
  const accessToken = session.accessToken ?? null;

  // `Session` exposes the shop *domain* but not the numeric shop id, and
  // `shops.shopId` is unique and referenced by every other table. So the GID is
  // read from the Admin API. If that read fails we fall back to the domain: it
  // is still unique, keeps installs working, and onboarding can reconcile it
  // later. Losing an install is much worse than a provisional id.
  let shopId = shopDomain;
  if (accessToken) {
    try {
      const identity = await fetchShopIdentity(shopDomain, accessToken);
      shopId = identity.id;
    } catch (error) {
      logger.warn("auth_shop_identity_failed", {
        shop_domain: shopDomain,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await upsertShop({ shopDomain, shopId, accessToken });

  // Plan probe is best-effort. A failure is logged and left as `null`
  // ("not yet known"), never thrown: losing a plan read must not block an
  // install, and onboarding can re-probe.
  if (accessToken) {
    try {
      const planName = await fetchShopPlanName(shopDomain, accessToken);
      const supported = checkoutSurfacesSupported(planName);
      const row = await findShopByDomain(shopDomain);
      if (row) await setCheckoutSupport(row.id, supported);

      logger.info("auth_plan_probe", {
        shop_domain: shopDomain,
        plan_name: planName,
        checkout_supported: supported,
      });
    } catch (error) {
      logger.warn("auth_plan_probe_failed", {
        shop_domain: shopDomain,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Embedded apps must land on a path the app itself owns. Without an explicit
  // redirect Shopify sends merchants to the app root, which would 404.
  const target = url.searchParams.get("redirect") ?? "/app";
  return redirect(safeInternalPath(target));
};

/**
 * Only ever redirect to our own paths. An absolute or protocol-relative URL in
 * `?redirect=` would turn the auth callback into an open redirect.
 */
function safeInternalPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/app";
  return value;
}