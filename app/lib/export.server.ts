import type { ExportContext } from "~/lib/analytics-queries.server";
import { parseSurveySettings } from "~/lib/settings";
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

  const { options } = parseSurveySettings(shop.optionsJson, {
    questionText: shop.questionText,
    options: [],
    allowOther: false,
  });

  return {
    shopDomain: shop.shopDomain,
    timeZone,
    labels: new Map(options.map((option) => [option.value, option.label] as const)),
  };
}
