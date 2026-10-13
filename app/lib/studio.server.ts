/**
 * Studio support: the shop display data the realistic checkout mock (S2) needs,
 * cached in memory per shop for ten minutes.
 *
 * The mock uses the shop's own name, currency and one active product so the
 * merchant recognises their store, but never real orders or customer data. The
 * cache keeps the Admin API cost off the critical path of every Studio load.
 */

import { fetchProductTitles, fetchShopDisplay } from "~/lib/shopify-graphql.server";

export type ShopDisplay = {
  name: string | null;
  currencyCode: string | null;
  product: { title: string; imageUrl: string | null } | null;
};

const TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { value: ShopDisplay; expiresAt: number }>();

export async function getShopDisplay(
  shopId: string,
  shopDomain: string,
  accessToken: string | null | undefined,
): Promise<ShopDisplay> {
  const now = Date.now();
  const cached = cache.get(shopId);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchShopDisplay(shopDomain, accessToken);
  cache.set(shopId, { value, expiresAt: now + TTL_MS });
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
  titleCache.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

/** Test seam: drop the cache between cases. */
export function clearShopDisplayCache(): void {
  cache.clear();
  titleCache.clear();
}
