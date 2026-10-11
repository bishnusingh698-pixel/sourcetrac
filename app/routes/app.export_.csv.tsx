import type { LoaderFunctionArgs } from "react-router";

import { fetchResponsesInWindow, toExportRows } from "~/lib/analytics-queries.server";
import { csvFilename, resolveExportTimeZone, toCsv } from "~/lib/csv";
import { loadExportContext } from "~/lib/export.server";
import { ensureShop } from "~/lib/provision.server";
import { backfillMissingOrders } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

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
  // fetched now, so their answers stop reading "Pending". Bounded and never throws.
  await backfillMissingOrders({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  // The query returns newest first; the file is oldest first.
  const [responses, context] = await Promise.all([
    fetchResponsesInWindow({ shopId: shop.id }),
    loadExportContext(shop, session),
  ]);
  const csv = toCsv(toExportRows([...responses].reverse(), context));

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(new Date(), resolveExportTimeZone(context.timeZone))}"`,
      // The file is generated per request from live data, so it must never be
      // cached by a proxy sitting in front of Render.
      "Cache-Control": "no-store",
    },
  });
});
