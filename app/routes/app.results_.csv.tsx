import type { LoaderFunctionArgs } from "react-router";

import { csvFilename, resolveExportTimeZone, tableToCsv, toSurveyTable } from "~/lib/csv";
import { buildSurveyExport, MAX_SURVEY_CSV_ROWS } from "~/lib/survey-export.server";
import { listSurveys } from "~/lib/surveys.server";
import { loadExportContext } from "~/lib/export.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { createTranslator } from "~/lib/i18n";
import { windowBounds } from "~/lib/analytics";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { parseCountryParam } from "@shared/countries";

/** The Results page's ranges in days; anything else is all time. */
const RANGE_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90 };

/**
 * Results CSV download (`/app/results/csv?survey=<id>`): the selected survey's
 * wide file, the same one the Export page offers for that survey. Built by
 * `buildSurveyExport`, so both downloads are identical.
 */
export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;
  const context = await loadExportContext(shop, session);
  const t = createTranslator(resolveAdminLanguage(request, shop.language, shop.adminLocale));
  // The same date range as the Results page the merchant downloaded from.
  const days = RANGE_DAYS[url.searchParams.get("range") ?? ""] ?? null;
  const window = days === null ? null : windowBounds(days, new Date(), resolveExportTimeZone(context.timeZone));

  const file = selectedId
    ? await buildSurveyExport({
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        timeZone: context.timeZone,
        t,
        surveyId: selectedId,
        ...(window ? { start: window.start, end: window.end } : {}),
        // The same country filter as the page the merchant downloaded from.
        country: parseCountryParam(url.searchParams.get("country")),
      })
    : { ...toSurveyTable([], []), truncated: false };

  return new Response(tableToCsv(file), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(new Date(), resolveExportTimeZone(context.timeZone))}"`,
      "X-SourceTrac-Truncated": String(file.truncated),
      "X-SourceTrac-Row-Limit": String(MAX_SURVEY_CSV_ROWS),
      "Cache-Control": "no-store",
    },
  });
});
