import type { LoaderFunctionArgs } from "react-router";

import { fetchResponsesInWindow, toExportRows } from "~/lib/analytics-queries.server";
import { csvFilename, resolveExportTimeZone, tableToCsv, toCsv } from "~/lib/csv";
import { loadExportContext } from "~/lib/export.server";
import { createTranslator } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import {
  buildAllSurveysExport,
  buildSurveyExport,
  MAX_SURVEY_CSV_ROWS,
  parseExportSelection,
} from "~/lib/survey-export.server";
import { listSurveys } from "~/lib/surveys.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/** Cap the CSV at a size that renders in under a second on Render free. */
const MAX_CSV_ROWS = 50_000;

/**
 * CSV download (`/app/export/csv?survey=all|channels|<survey id>`).
 *
 * A resource route that returns the file. The Export page fetches it with the
 * App Bridge session token and saves the blob; see `app.export.tsx`.
 *
 * - `all` (the default): every survey, one row per answer.
 * - a survey id: that survey, one row per buyer, one column per question.
 * - `channels`: the original "how did you hear about us" file, one row per
 *   order. Columns are listed and explained in `~/lib/csv`.
 *
 * There is no customer name, email or address anywhere in these files,
 * deliberately, both for privacy and for App Store review. Revenue status uses
 * the same decision as the dashboard and Results, so `counted` rows are exactly
 * the orders those pages sum.
 */
export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  // Orders the webhooks never delivered (placed before install, for one) are
  // fetched in the background (never blocking this page), so their answers stop
  // reading "Pending" on the next load. Bounded and never throws.
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const selection = parseExportSelection(new URL(request.url).searchParams.get("survey"), await listSurveys(shop.id));
  const context = await loadExportContext(shop, session);
  const timeZone = resolveExportTimeZone(context.timeZone);

  let csv: string;
  let truncated: boolean;
  let limit: number;
  if (selection.kind === "channels") {
    // The query returns newest first; the file is oldest first. One row past
    // the cap is read only to know whether anything was left out.
    const fetched = await fetchResponsesInWindow({ shopId: shop.id, limit: MAX_CSV_ROWS + 1 });
    truncated = fetched.length > MAX_CSV_ROWS;
    const responses = truncated ? fetched.slice(0, MAX_CSV_ROWS) : fetched;
    csv = toCsv(toExportRows([...responses].reverse(), context));
    limit = MAX_CSV_ROWS;
  } else {
    const params = {
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      timeZone: context.timeZone,
      t: createTranslator(resolveAdminLanguage(request, shop.language, shop.adminLocale)),
    };
    const file =
      selection.kind === "survey"
        ? await buildSurveyExport({ ...params, surveyId: selection.surveyId })
        : await buildAllSurveysExport(params);
    csv = tableToCsv(file);
    truncated = file.truncated;
    limit = MAX_SURVEY_CSV_ROWS;
  }

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(new Date(), timeZone)}"`,
      // Signal a truncated file so the client can warn the merchant instead of
      // silently presenting a partial export as complete.
      "X-SourceTrac-Truncated": String(truncated),
      "X-SourceTrac-Row-Limit": String(limit),
      // The file is generated per request from live data, so it must never be
      // cached by a proxy sitting in front of Render.
      "Cache-Control": "no-store",
    },
  });
});
