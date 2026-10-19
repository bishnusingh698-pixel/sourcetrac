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
/** One provisioning per shop at a time: parallel first loaders share it. */
const provisioning = new Map<string, Promise<{ id: string }>>();

export function provisionShop(session: { shop: string; accessToken?: string | null }): Promise<{ id: string }> {
  const running = provisioning.get(session.shop);
  if (running) return running;
  const run = provisionShopOnce(session).finally(() => provisioning.delete(session.shop));
  provisioning.set(session.shop, run);
  return run;
}

async function provisionShopOnce(session: {
  shop: string;
  accessToken?: string | null;
}): Promise<{ id: string }> {
  const shopDomain = session.shop;
  const accessToken = session.accessToken ?? null;

  // Fall back to the domain if the GID read fails: still unique, keeps the
  // install working. Losing an install is worse than a provisional id.
  // `ensureShop` replaces the placeholder on a later load.
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

  const row = await upsertShop({ shopDomain, shopId });

  // Best-effort plan probe, in the background: the first page load after
  // install used to wait on it (a second Admin call with its own timeout and
  // retries). A failed lookup leaves the stored answer as it was.
  if (accessToken) void probeCheckoutSupport(row.id, shopDomain, accessToken);

  return row;
}

async function probeCheckoutSupport(shopId: string, shopDomain: string, accessToken: string): Promise<void> {
  try {
    const planName = await fetchShopPlanName(shopDomain, accessToken);
    // A failed lookup (null) must not erase a known answer: a Starter shop
    // would lose its "plan blocked" banner on one 5xx.
    if (planName === null) return;
    const supported = checkoutSurfacesSupported(planName);
    await setCheckoutSupport(shopId, supported);
    logger.info("auth_plan_probe", { shop_domain: shopDomain, plan_name: planName, checkout_supported: supported });
  } catch (error) {
    logger.warn("auth_plan_probe_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Shops whose placeholder id was retried in this process, so a failing lookup is not repeated per load. */
const placeholderRetried = new Set<string>();

/** Existing installed shop, or provision it now. */
export async function ensureShop(session: {
  shop: string;
  accessToken?: string | null;
}): Promise<ShopRecord> {
  const existing = await findShopByDomain(session.shop);
  if (existing && existing.installState === "installed") {
    // A first install whose identity lookup failed stored the domain as the
    // shop id. Replace it with the real GID once Shopify answers.
    if (!existing.shopId.startsWith("gid://") && session.accessToken && !placeholderRetried.has(session.shop)) {
      placeholderRetried.add(session.shop);
      try {
        const identity = await fetchShopIdentity(session.shop, session.accessToken);
        await upsertShop({ shopDomain: session.shop, shopId: identity.id });
        return requireShopByDomain(session.shop);
      } catch (error) {
        logger.warn("shop_placeholder_id_retry_failed", {
          shop_domain: session.shop,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return existing;
  }

  await provisionShop(session);
  return requireShopByDomain(session.shop);
}
