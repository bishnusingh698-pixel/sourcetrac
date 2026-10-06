import type { LoaderFunctionArgs } from "react-router";

import { fetchResponsesInWindow, toExportRows } from "~/lib/analytics-queries.server";
import { csvFilename, toCsv } from "~/lib/csv";
import { ensureShop } from "~/lib/provision.server";
import { authenticate } from "~/shopify.server";

/**
 * CSV download (`/app/export.csv`).
 *
 * Kept as a resource route so it is a plain GET that returns a file. A download
 * link works without JavaScript and can be bookmarked or wrapped in a scheduled
 * job by the merchant.
 *
 * Columns are fixed at order_id, submitted_at, channel, order_total, currency.
 * There is no customer name, email or address anywhere in this file, deliberately,
 * both for privacy and for App Store review.
 *
 * `order_total` comes from the SAME query and the SAME revenue decision as the
 * dashboard (`toExportRows` -> `decideRevenue`): the net amount, in the order's
 * currency. It is blank when the dashboard would not count the answer's revenue
 * (pending, cancelled, test, voided, fully refunded), so a blank cell means "not
 * counted", never "free", and the file can never disagree with the dashboard.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  // The query returns newest first; the file is oldest first.
  const responses = await fetchResponsesInWindow({ shopId: shop.id });
  const csv = toCsv(toExportRows([...responses].reverse()));

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename()}"`,
      // The file is generated per request from live data, so it must never be
      // cached by a proxy sitting in front of Render.
      "Cache-Control": "no-store",
    },
  });
};
