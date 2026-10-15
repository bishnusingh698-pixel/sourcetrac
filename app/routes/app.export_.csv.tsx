import type { LoaderFunctionArgs } from "react-router";

import { fetchResponsesInWindow, toExportRows } from "~/lib/analytics-queries.server";
import { csvFilename, resolveExportTimeZone, toCsv } from "~/lib/csv";
import { loadExportContext } from "~/lib/export.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/** Cap the CSV at a size that renders in under a second on Render free. */
const MAX_CSV_ROWS = 50_000;

/**
 * CSV download (`/app/export/csv`).
 *
 * A resource route that returns the file. The Export page fetches it with the
 * App Bridge session token and saves the blob; see `app.export.tsx`.
 *
 * Columns are listed and explained in `~/lib/csv`. There is no customer name,
 * email or address anywhere in this file, deliberately, both for privacy and
 * for App Store review.
 *
 * `revenue_status` comes from the SAME query and the SAME revenue decision as
 * the dashboard (`toExportRows` -> `decideRevenue`), so the rows marked
 * `counted` are exactly the orders the dashboard sums.
 */
export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  // Orders the webhooks never delivered (placed before install, for one) are
  // fetched in the background (never blocking this page), so their answers stop
  // reading "Pending" on the next load. Bounded and never throws.
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  // The query returns newest first; the file is oldest first. One row past the
  // cap is read only to know whether anything was left out: a shop with
  // exactly the cap is complete. When truncated, the newest answers are kept.
  const [fetched, context] = await Promise.all([
    fetchResponsesInWindow({ shopId: shop.id, limit: MAX_CSV_ROWS + 1 }),
    loadExportContext(shop, session),
  ]);
  const truncated = fetched.length > MAX_CSV_ROWS;
  const responses = truncated ? fetched.slice(0, MAX_CSV_ROWS) : fetched;
  const csv = toCsv(toExportRows([...responses].reverse(), context));

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(new Date(), resolveExportTimeZone(context.timeZone))}"`,
      // Signal a truncated file so the client can warn the merchant instead of
      // silently presenting a partial export as complete.
      "X-SourceTrac-Truncated": String(truncated),
      "X-SourceTrac-Row-Limit": String(MAX_CSV_ROWS),
      // The file is generated per request from live data, so it must never be
      // cached by a proxy sitting in front of Render.
      "Cache-Control": "no-store",
    },
  });
});
