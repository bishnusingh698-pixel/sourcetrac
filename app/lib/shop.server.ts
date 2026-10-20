import type { PlanStatus } from "@prisma/client";

import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";

import { db, isRetryableDbError } from "~/db.server";
import { NotFoundError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { DEFAULT_OPTIONS, type SurveyOption } from "~/lib/settings";
import { withRetry } from "~/lib/retry.server";

/**
 * Shop repository. Owns encryption-at-rest of offline access tokens so no
 * other module has to know the ciphertext format.
 */

export type ShopRecord = {
  id: string;
  shopDomain: string;
  shopId: string;
  plan: string;
  planStatus: string;
  subscriptionGid: string | null;
  questionText: string;
  optionsJson: string;
  allowOther: boolean;
  /// Merchant's chosen admin UI language, or null if never chosen.
  language: string | null;
  /// Shopify admin locale last seen on a document load. Fallback only.
  adminLocale: string | null;
  checkoutSupported: boolean | null;
  /// When the checkout-support plan check last ran.
  checkoutCheckedAt: Date | null;
  installState: "installed" | "uninstalled";
  /// When the current installation began (null on rows from before it was kept).
  installedAt: Date | null;
  /// When Shopify last granted a token for the shop.
  authorizedAt: Date | null;
  /// When the latest app/uninstalled was triggered, kept across reinstalls.
  uninstallTriggeredAt: Date | null;
};

export function defaultOptionsJson(): string {
  return JSON.stringify(DEFAULT_OPTIONS satisfies SurveyOption[]);
}

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, {
    attempts: 3,
    baseDelayMs: 250,
    shouldRetry: isRetryableDbError,
  });
}

/**
 * Two first loads of a new shop can both try to create its row; the loser's
 * P2002 means the row now exists, so the upsert is simply run again.
 */
async function retryUniqueRace<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await retryDb(operation);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
    return retryDb(operation);
  }
}

/**
 * Upsert on shopDomain. Used by OAuth and by reinstall.
 *
 * No access token is stored here. The offline token lives only in the session
 * storage, which refreshes it (see `getAccessToken`); a copy on this row would
 * be expired within the hour, or a legacy non-expiring token Shopify rejects.
 */
export async function upsertShop(params: { shopDomain: string; shopId: string }): Promise<{ id: string }> {
  const { shopDomain, shopId } = params;

  // The shop's GID is unique, its myshopify domain need not stay the same. A
  // row stored under an earlier domain is moved to this one; otherwise the
  // upsert below tried to create a second row with the same GID and failed on
  // every admin load.
  if (shopId.startsWith("gid://")) {
    const [byGid, byDomain] = await Promise.all([
      retryDb(() => db.shop.findUnique({ where: { shopId }, select: { id: true, shopDomain: true } })),
      retryDb(() => db.shop.findUnique({ where: { shopDomain }, select: { id: true } })),
    ]);
    if (byGid && byGid.shopDomain !== shopDomain && !byDomain) {
      await retryDb(() => db.shop.update({ where: { id: byGid.id }, data: { shopDomain } }));
      logger.info("shop_domain_changed", { shop_id: byGid.id, from: byGid.shopDomain, to: shopDomain });
    }
  }

  // A new installation starts now; a re-auth of a live one keeps its start.
  const prior = await retryDb(() =>
    db.shop.findUnique({ where: { shopDomain }, select: { installState: true, installedAt: true } }),
  );
  const startsInstallation = !prior || prior.installState !== "installed" || prior.installedAt === null;

  const row = await retryUniqueRace(() =>
    db.shop.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        shopId,
        optionsJson: defaultOptionsJson(),
        installState: "installed",
        uninstalledAt: null,
        installedAt: new Date(),
        authorizedAt: new Date(),
      },
      update: {
        // provisionShop falls back to the domain when Shopify's identity lookup
        // fails; that placeholder must never replace a real GID already stored.
        ...(shopId.startsWith("gid://") ? { shopId } : {}),
        installState: "installed",
        uninstalledAt: null,
        ...(startsInstallation ? { installedAt: new Date() } : {}),
        // Every caller holds a session Shopify just granted or accepted, so the
        // app is installed now. A late uninstall triggered before this moment
        // belongs to an earlier installation, even when that uninstall was
        // never recorded and `installedAt` is still the old one.
        authorizedAt: new Date(),
      },
      select: { id: true },
    }),
  );

  return row;
}

export async function findShopByDomain(shopDomain: string): Promise<ShopRecord | null> {
  return retryDb(() =>
    db.shop.findUnique({
      where: { shopDomain },
      select: {
        id: true,
        shopDomain: true,
        shopId: true,
        plan: true,
        planStatus: true,
        subscriptionGid: true,
        questionText: true,
        optionsJson: true,
        allowOther: true,
        language: true,
        adminLocale: true,
        checkoutSupported: true,
        checkoutCheckedAt: true,
        installState: true,
        installedAt: true,
        authorizedAt: true,
        uninstallTriggeredAt: true,
      },
    }),
  );
}

/**
 * The latest moment the app is known to have been installed on this shop: the
 * start of its current installation or Shopify's last token grant.
 */
export function lastKnownInstalledAt(shop: { installedAt: Date | null; authorizedAt: Date | null }): Date | null {
  const times = [shop.installedAt, shop.authorizedAt].filter((t): t is Date => t !== null);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

/** Lookup for request paths where an unknown shop must 404. */
export async function requireShopByDomain(shopDomain: string): Promise<ShopRecord> {
  const shop = await findShopByDomain(shopDomain);
  if (!shop) throw new NotFoundError("Shop is not installed", { shop_domain: shopDomain });
  return shop;
}

/** Lookup by internal id. Returns null when the shop does not exist. */
export async function findShopById(shopId: string): Promise<ShopRecord | null> {
  return retryDb(() =>
    db.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        shopDomain: true,
        shopId: true,
        plan: true,
        planStatus: true,
        subscriptionGid: true,
        questionText: true,
        optionsJson: true,
        allowOther: true,
        language: true,
        adminLocale: true,
        checkoutSupported: true,
        checkoutCheckedAt: true,
        installState: true,
        installedAt: true,
        authorizedAt: true,
        uninstallTriggeredAt: true,
      },
    }),
  );
}

/**
 * The shop's offline token for work outside an admin request (sync, webhooks,
 * the admin blocks). Returns null when there is none — callers must handle null
 * by skipping, not by crashing.
 *
 * Offline tokens expire after about an hour, so the only source is the
 * library's offline session, which `unauthenticated.admin` refreshes with the
 * stored refresh token (and which `EncryptedSessionStorage` swaps for an
 * expiring one if it still holds a legacy token). There is deliberately no
 * fallback to a stored copy: Shopify refuses a non-expiring token with 403, so
 * an old copy could only turn a skipped call into a failed one.
 */
export async function getAccessToken(internalShopId: string): Promise<string | null> {
  const row = await retryDb(() => db.shop.findUnique({ where: { id: internalShopId }, select: { shopDomain: true } }));
  if (!row) return null;
  return freshOfflineToken(row.shopDomain);
}

/**
 * Load the offline session through the library so an expired token is
 * refreshed first. Imported lazily: `shopify.server` imports this module (via
 * provisioning), and a static import would make the two load each other.
 */
const tokenLoads = new Map<string, Promise<string | null>>();

function freshOfflineToken(shopDomain: string): Promise<string | null> {
  // One load (and so at most one refresh) per shop at a time in this process:
  // a webhook and a sync drain asking together used to spend the same refresh
  // token twice.
  const running = tokenLoads.get(shopDomain);
  if (running) return running;
  const load = loadFreshOfflineToken(shopDomain).finally(() => tokenLoads.delete(shopDomain));
  tokenLoads.set(shopDomain, load);
  return load;
}

async function loadFreshOfflineToken(shopDomain: string): Promise<string | null> {
  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { session } = await unauthenticated.admin(shopDomain);
    return session.accessToken ?? null;
  } catch (error) {
    // No stored session (SessionNotFoundError) is the normal case for a shop
    // that has not opened the app since the token change; anything else is a
    // failed refresh and worth seeing.
    if (!(error instanceof SessionNotFoundError)) {
      logger.warn("offline_token_refresh_failed", {
        shop_domain: shopDomain,
        error_message: error instanceof Error ? error.message : error instanceof Response ? `HTTP ${error.status}` : String(error),
      });
    }
    return null;
  }
}

/**
 * Mark the shop uninstalled. Also clears the token columns, which nothing writes
 * any more but older rows may still hold.
 */
export async function clearAccessToken(internalShopId: string): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: {
        accessTokenEncrypted: null,
        accessTokenIv: null,
        accessTokenTag: null,
        installState: "uninstalled",
        uninstalledAt: new Date(),
        // Shopify cancels every app subscription on uninstall. Keeping the paid
        // plan meant a reinstall came back on Growth/Scale with nothing billed,
        // because no later notice ever corrected it.
        plan: "free",
        // The paid charge ended with the uninstall; recorded the same way the
        // Plans page records a charge it no longer finds.
        planStatus: "cancelled",
        subscriptionGid: null,
        planDisplayName: null,
      },
    }),
  );
}

export async function updateSettings(
  internalShopId: string,
  data: { questionText: string; optionsJson: string; allowOther: boolean },
): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: {
        questionText: data.questionText,
        optionsJson: data.optionsJson,
        allowOther: data.allowOther,
      },
    }),
  );
}

/**
 * Record the merchant's language choice.
 *
 * A separate function rather than another field on `updateSettings` because the
 * two are written at completely different moments: `updateSettings` is the
 * survey form's Save button, whereas language is changed from a dropdown that
 * applies immediately. Sharing one function would mean a language click could
 * accidentally overwrite survey settings with stale form state.
 *
 * The value is validated by the caller against `isSupportedLanguage`; a null
 * clears the override and restores locale detection.
 */
export async function setLanguage(
  internalShopId: string,
  language: string | null,
): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: { language },
    }),
  );
}

export async function setPlan(
  internalShopId: string,
  data: {
    plan: "free" | "growth" | "scale";
    planStatus: PlanStatus;
    subscriptionGid: string | null;
    planDisplayName?: string | null;
  },
): Promise<void> {
  await retryDb(() =>
    db.shop.update({ where: { id: internalShopId }, data }),
  );
  if (data.plan !== "free" && data.planStatus === "active") await unlockAnswers(internalShopId);
  // The checkout serves the plan's share of live surveys from a cached
  // config; an upgrade must show the extra surveys now, not a minute later.
  // Imported on use: surveys.server imports this module.
  const { invalidateConfig } = await import("~/lib/surveys.server");
  await invalidateConfig(internalShopId);
}

/**
 * Clear the over-cap flag once a shop is on a paid plan. The flag exists to
 * prompt an upgrade; after one, the answers are simply the merchant's data, and
 * a retried submit must report them as counted.
 */
async function unlockAnswers(internalShopId: string): Promise<void> {
  await retryDb(() => db.response.updateMany({ where: { shopId: internalShopId, flagged: true }, data: { flagged: false } }));
  await retryDb(() =>
    db.surveyResponse.updateMany({ where: { shopId: internalShopId, isLocked: true }, data: { isLocked: false } }),
  );
}

/**
 * Whether this order already has a response.
 *
 * The extension renders on both the Thank-you and Order-status pages, so this
 * is what stops a buyer being asked the same question twice. It is a separate
 * function rather than a call into responses.server.ts to keep the shop module
 * free of survey-response dependencies.
 */
export async function hasResponseFor(internalShopId: string, orderId: string): Promise<boolean> {
  // Both stores: the multi-question blocks write `Response`, so an order
  // answered there must also hide the single-question survey.
  const [legacy, v2] = await Promise.all([
    retryDb(() => db.surveyResponse.count({ where: { shopId: internalShopId, orderId } })),
    retryDb(() => db.response.count({ where: { shopId: internalShopId, orderId } })),
  ]);
  return legacy + v2 > 0;
}

/**
 * Remember the Shopify admin's locale. Only the first document load carries
 * `?locale=`; client-side navigations drop it, so without this the language fell
 * through to the browser's Accept-Language and the app could switch from German
 * to English on the first click.
 */
export async function rememberAdminLocale(internalShopId: string, locale: string): Promise<void> {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale)) return;
  await retryDb(() => db.shop.update({ where: { id: internalShopId }, data: { adminLocale: locale } }));
}

/**
 * Whether Shopify has told us about this order (an `orders/*` webhook or the
 * backfill wrote it). Used to let real buyers past the shop-wide rate-limit
 * backstop: an attacker's made-up order ids are never in the cache.
 */
export async function isKnownOrder(shopDomain: string, orderId: string): Promise<boolean> {
  const shop = await findShopByDomain(shopDomain);
  if (!shop) return false;
  const row = await retryDb(() =>
    db.orderCache.findUnique({ where: { shopId_orderId: { shopId: shop.id, orderId } }, select: { id: true } }),
  );
  return row !== null;
}

export async function setCheckoutSupport(internalShopId: string, supported: boolean | null): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: { checkoutSupported: supported, checkoutCheckedAt: new Date() },
    }),
  );
}
