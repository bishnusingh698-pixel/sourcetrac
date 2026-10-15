import { fetchChannelLabels, type ExportContext } from "~/lib/analytics-queries.server";
import { getAccessToken, type ShopRecord } from "~/lib/shop.server";
import { fetchShopTimeZone } from "~/lib/shopify-graphql.server";

/**
 * Everything the CSV and its preview need beyond the rows themselves. Shared
 * so the preview on the Export page is the downloaded file, value for value.
 *
 * The time zone is asked of Shopify on each export rather than stored: it is
 * one cheap query per download, and a merchant who changes their store's zone
 * gets the new one immediately.
 */
export async function loadExportContext(
  shop: ShopRecord,
  session: { accessToken?: string | null },
): Promise<ExportContext> {
  const accessToken = session.accessToken ?? (await getAccessToken(shop.id));
  const timeZone = await fetchShopTimeZone(shop.shopDomain, accessToken);

  return {
    shopDomain: shop.shopDomain,
    timeZone,
    // Legacy channel values and every survey option, so v2 answers are named.
    labels: await fetchChannelLabels(shop),
  };
}
