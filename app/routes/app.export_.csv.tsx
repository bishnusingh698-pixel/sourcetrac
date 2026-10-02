import { redirect, type LoaderFunctionArgs } from "react-router";

import { db } from "~/db.server";
import { csvFilename, toCsv } from "~/lib/csv";
import { formatDecimalForCurrency } from "~/lib/money";
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
 * `order_total` is the decided amount (order total minus refunds), converted to
 * a plain decimal string. It is blank when the order has not arrived yet, so an
 * empty cell means "unknown", never "free".
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findShopByDomain(session.shop);
  if (!shop) return redirect("/auth?redirect=/app/export");

  const responses = await db.surveyResponse.findMany({
    where: { shopId: shop.id },
    orderBy: { submittedAt: "asc" },
    select: {
      orderId: true,
      submittedAt: true,
      channel: true,
      currency: true,
      orderTotal: true,
    },
  });

  const csv = toCsv(
    responses.map((row) => ({
      orderId: row.orderId,
      submittedAt: row.submittedAt,
      channel: row.channel,
      // `orderTotal` is stored in major units (see responses.server.ts, which
      // writes `minor / 10 ** decimals`), so it is emitted as a plain decimal
      // string. Converting back through minor units here would be wrong twice
      // over for zero-decimal currencies like JPY. Precision follows the
      // currency: three places for KWD/BHD/OMR, none for JPY.
      orderTotal: formatDecimalForCurrency(row.orderTotal, row.currency ?? "USD"),
      currency: row.currency,
    })),
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
