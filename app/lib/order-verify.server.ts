import { RateLimitError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { BUCKETS, consumeToken } from "~/lib/rate-limit.server";
import { findShopByDomain, getAccessToken, isKnownOrder } from "~/lib/shop.server";
import { shopifyGraphql } from "~/lib/shopify-graphql.server";

/**
 * Whether an order id names a real order of this shop, for the shop-wide
 * rate-limit backstop's exemption.
 *
 * The backstop is shared by every buyer of a store, and one lifted checkout
 * token with made-up order ids could drain it. Orders already in the cache were
 * exempt, but a Thank-you answer usually arrives before `orders/create`, so real
 * buyers were refused for the whole retry budget and their answers lost. Once
 * the bucket is empty an id the cache does not know is looked up in Shopify:
 * a real order exists there (the buyer is looking at its confirmation), a
 * made-up id does not. Lookups are bounded per shop; a found order is
 * remembered. "Not found" is not: on the Thank-you page Shopify may create the
 * order a few seconds after the first submit, and a remembered "no" refused
 * every retry inside the extension's budget.
 */
const ORDER_EXISTS = `#graphql
  query SourceTracOrderExists($id: ID!) {
    order(id: $id) { id }
  }
`;

const REAL_TTL_MS = 10 * 60 * 1000;
const remembered = new Map<string, number>();

export async function isRealOrder(shopDomain: string, orderId: string, now = Date.now()): Promise<boolean> {
  if (await isKnownOrder(shopDomain, orderId)) return true;

  const key = `${shopDomain}:${orderId}`;
  const until = remembered.get(key);
  if (until !== undefined && until > now) return true;

  try {
    consumeToken(`order-verify:${shopDomain}`, BUCKETS.orderVerifyShop);
  } catch (error) {
    if (error instanceof RateLimitError) return false;
    throw error;
  }

  const shop = await findShopByDomain(shopDomain);
  if (!shop) return false;
  const accessToken = await getAccessToken(shop.id);
  if (!accessToken) return false;

  let real: boolean;
  try {
    const result = await shopifyGraphql<{ order: { id: string } | null }>(shopDomain, accessToken, ORDER_EXISTS, {
      id: `gid://shopify/Order/${orderId}`,
    });
    real = result.data.order !== null;
  } catch (error) {
    // Unknown, not "fake": stays throttled this time, asked again next time.
    logger.warn("order_verify_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (real) {
    if (remembered.size > 10_000) remembered.clear();
    remembered.set(key, now + REAL_TTL_MS);
  }
  return real;
}

/** Test helper. */
export function clearOrderVerifyCache(): void {
  remembered.clear();
}
