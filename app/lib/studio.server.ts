/**
 * Studio support: the shop display data the realistic checkout mock (S2) needs,
 * cached in memory per shop for ten minutes.
 *
 * The mock uses the shop's own name, currency and one active product so the
 * merchant recognises their store, but never real orders or customer data. The
 * cache keeps the Admin API cost off the critical path of every Studio load.
 */

import { fetchProductTitles, fetchShopDisplay, fetchShopLocaleInfo } from "~/lib/shopify-graphql.server";
import { isValidTimeZone } from "@shared/zoned-date";

export type ShopDisplay = {
  name: string | null;
  currencyCode: string | null;
  product: { title: string; imageUrl: string | null } | null;
};

const TTL_MS = 10 * 60 * 1000;
/** A lookup that came back empty is usually a transient Admin API failure. */
const EMPTY_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map<string, { value: ShopDisplay; expiresAt: number }>();

/** Drop expired entries, then the oldest, so neither cache grows without bound. */
function prune<V>(map: Map<string, { value: V; expiresAt: number }>, now: number): void {
  if (map.size < MAX_ENTRIES) return;
  for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
  for (const key of map.keys()) {
    if (map.size < MAX_ENTRIES) break;
    map.delete(key);
  }
}

export async function getShopDisplay(
  shopId: string,
  shopDomain: string,
  accessToken: string | null | undefined,
): Promise<ShopDisplay> {
  const now = Date.now();
  const cached = cache.get(shopId);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchShopDisplay(shopDomain, accessToken);
  prune(cache, now);
  cache.set(shopId, { value, expiresAt: now + (value.name === null ? EMPTY_TTL_MS : TTL_MS) });
  return value;
}

/**
 * Product titles for the Results tab's "By product" table (T8), cached in memory
 * per shop for ten minutes so filtering never re-hits the Admin API. The cache
 * key includes the requested ids, so a filter that names new products still
 * resolves them.
 */
const titleCache = new Map<string, { value: Record<string, string>; expiresAt: number }>();

export async function getProductTitles(
  shopId: string,
  shopDomain: string,
  accessToken: string | null | undefined,
  productIds: ReadonlyArray<string>,
): Promise<Record<string, string>> {
  const key = `${shopId}:${[...new Set(productIds)].sort().join(",")}`;
  const now = Date.now();
  const cached = titleCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchProductTitles(shopDomain, accessToken, productIds);
  prune(titleCache, now);
  const empty = productIds.length > 0 && Object.keys(value).length === 0;
  titleCache.set(key, { value, expiresAt: now + (empty ? EMPTY_TTL_MS : TTL_MS) });
  return value;
}

/**
 * The shop's IANA time zone and country, cached per shop. Home and the
 * Responses page need them on every load; asking Shopify each time put a
 * blocking Admin API call (with its timeout and retries) in front of the page.
 */
const LOCALE_TTL_MS = 60 * 60 * 1000;
const localeCache = new Map<string, { value: { timeZone: string | null; countryCode: string | null }; expiresAt: number }>();

export async function getShopLocaleInfo(
  shopId: string,
  shopDomain: string,
  accessToken: string | null | undefined,
): Promise<{ timeZone: string | null; countryCode: string | null }> {
  const now = Date.now();
  const cached = localeCache.get(shopId);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchShopLocaleInfo(shopDomain, accessToken);
  prune(localeCache, now);
  localeCache.set(shopId, { value, expiresAt: now + (value.timeZone === null ? EMPTY_TTL_MS : LOCALE_TTL_MS) });
  return value;
}

/**
 * The zone reports are cut in: the store's own, or UTC when Shopify cannot be
 * asked just now. Pages that show dates name the zone they used.
 */
export async function getReportTimeZone(
  shopId: string,
  shopDomain: string,
  accessToken: string | null | undefined,
): Promise<string> {
  const { timeZone } = await getShopLocaleInfo(shopId, shopDomain, accessToken);
  return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/** Test seam: drop the cache between cases. */
export function clearShopDisplayCache(): void {
  cache.clear();
  titleCache.clear();
  localeCache.clear();
}
