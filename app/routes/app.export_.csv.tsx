import { redirect, type LoaderFunctionArgs } from "react-router";

import { csvFilename, toCsv } from "~/lib/csv";
import { fetchAllResponsesWithOrder } from "~/lib/analytics-queries.server";
import { formatDecimalForCurrency, minorUnitDigits } from "~/lib/money";
import { evaluateResponseRevenue } from "~/lib/revenue";
import { findShopByDomain } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * CSV download (`/app/export.csv`).
 *
 * Kept as a resource route so it is a plain GET that returns a file. A download
 * link works without JavaScript and can be bookmarked or wrapped in a scheduled
 * job by the merchant.
 *
 * Columns are fixed at order_id, submitted_at, channel, order_total, currency.
 * There is no customer name, email or address anywhere in this file — deliberate,
 * both for privacy and for App Store review.
 *
 * `order_total` is the decided amount -- the order total net of refunds, the same
 * figure the dashboard attributes to that channel -- produced by
 * `evaluateResponseRevenue` rather than a second implementation of the policy.
 * It is blank for any order that contributes no revenue, whether because it has
 * not arrived yet or because it was cancelled or refunded, so an empty cell
 * means "no revenue figure", never "free".
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findShopByDomain(session.shop);
  if (!shop) return redirect("/auth?redirect=/app/export");

  const responses = await fetchAllResponsesWithOrder(shop.id);

  const csv = toCsv(
    responses.map((row) => {
      const decision = evaluateResponseRevenue(
        { reconciled: row.reconciled, unreconcilable: row.unreconcilable },
        row.order,
      );

      return {
        orderId: row.orderId,
        submittedAt: row.submittedAt,
        channel: row.channel,
        // The decided amount, net of refunds, converted back to major units at
        // the currency's own precision: three places for KWD/BHD/OMR, none for
        // JPY. Any order that contributes no revenue -- pending, test,
        // cancelled or fully refunded -- writes an empty cell, which is the same
        // "unknown" the dashboard shows, never a misleading $0.00.
        orderTotal: decision.included
          ? formatDecimalForCurrency(
              decision.minor / 10 ** minorUnitDigits(row.order?.currency ?? "USD"),
              row.order?.currency ?? "USD",
            )
          : null,
        currency: row.order?.currency ?? null,
      };
    }),
  );

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
