import { logger } from "~/lib/logger";
import { checkoutSurfacesSupported, fetchShopIdentity, fetchShopPlanName } from "~/lib/shopify-rest.server";
import {
  findShopByDomain,
  requireShopByDomain,
  setCheckoutSupport,
  upsertShop,
  type ShopRecord,
} from "~/lib/shop.server";

/**
 * Create or refresh our own `shops` row for an authenticated session.
 *
 * Embedded apps authenticate by token exchange, so `/auth/callback` is never hit
 * on install and the row must be provisioned from `afterAuth` (new sessions) and
 * from the admin shell loader (sessions that already exist).
 */
export async function provisionShop(session: {
  shop: string;
  accessToken?: string | null;
}): Promise<{ id: string }> {
  const shopDomain = session.shop;
  const accessToken = session.accessToken ?? null;

  // Fall back to the domain if the GID read fails: still unique, keeps the
  // install working. Losing an install is worse than a provisional id.
  let shopId = shopDomain;
  if (accessToken) {
    try {
      shopId = (await fetchShopIdentity(shopDomain, accessToken)).id;
    } catch (error) {
      logger.warn("auth_shop_identity_failed", {
        shop_domain: shopDomain,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const row = await upsertShop({ shopDomain, shopId, accessToken });

  // Best-effort plan probe; a failure leaves checkoutSupported null ("unknown").
  if (accessToken) {
    try {
      const planName = await fetchShopPlanName(shopDomain, accessToken);
      const supported = checkoutSurfacesSupported(planName);
      await setCheckoutSupport(row.id, supported);
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

  return row;
}

/** Existing installed shop, or provision it now. */
export async function ensureShop(session: {
  shop: string;
  accessToken?: string | null;
}): Promise<ShopRecord> {
  const existing = await findShopByDomain(session.shop);
  if (existing && existing.installState === "installed") return existing;

  await provisionShop(session);
  return requireShopByDomain(session.shop);
}
