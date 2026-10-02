import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Panel } from "~/components/admin-ui";
import { CSV_HEADERS } from "~/lib/csv";
import { fetchAllResponsesWithOrder } from "~/lib/analytics-queries.server";
import { formatDecimalForCurrency, minorUnitDigits } from "~/lib/money";
import { evaluateResponseRevenue } from "~/lib/revenue";
import { db } from "~/db.server";
import { findShopByDomain } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * Export page.
 *
 * One primary action: "Download CSV". It links straight to the resource route,
 * so the download works without JavaScript.
 *
 * The page shows the exact column list before the merchant commits, because a
 * CSV that does not match expectations is only discovered after it is already
 * open in a spreadsheet.
 */

export const meta: MetaFunction = () => [{ title: "Export — SourceTrac" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findShopByDomain(session.shop);
  if (!shop) {
    throw new Response(null, { status: 302, headers: { Location: "/auth?redirect=/app/export" } });
  }

  const count = await db.surveyResponse.count({ where: { shopId: shop.id } });

  /**
   * A preview of the newest rows, so merchants can confirm the file looks right
   * before downloading.
   *
   * Built from the same shared join and the same `evaluateResponseRevenue` policy
   * as /app/export.csv, so the preview is genuinely byte-identical to the file.
   * Reading `orderTotal` off the response row here instead showed the gross
   * order total while the dashboard — and now the file — show the net of
   * refunds, so the preview promised a file it did not describe. The limit is
   * pushed into SQL rather than applied with `.slice()` so a shop with a long
   * history does not load every row to show ten.
   */
  // The shared query returns newest-first, so LIMIT 10 is already the preview.
  const recent = await fetchAllResponsesWithOrder(shop.id, 10);

  return {
    count,
    headers: [...CSV_HEADERS],
    recent: recent.map((row) => {
      const decision = evaluateResponseRevenue(
        { reconciled: row.reconciled, unreconcilable: row.unreconcilable },
        row.order,
      );
      const currency = row.order?.currency ?? "USD";

      return {
        orderId: row.orderId,
        submittedAt: row.submittedAt.toISOString(),
        channel: row.channel,
        orderTotal: decision.included
          ? (formatDecimalForCurrency(
              decision.minor / 10 ** minorUnitDigits(currency),
              currency,
            ) ?? "")
          : "",
        currency: row.order?.currency ?? "",
      };
    }),
  };
};

export default function Export() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-stack gap="base">
      <s-section
        heading="Export"
        subheading="Download every answer as a spreadsheet, newest last."
        padding="none"
      />

      <Panel title="Your export">
        <s-stack gap="base">
          <s-text>
            {data.count === 0
              ? "You have no answers to export yet. Once buyers start answering, they will appear here."
              : `This file will contain all ${data.count} of your answers.`}
          </s-text>

          <s-text color="subdued" fontSize="small">
            Columns: {data.headers.join(", ")}. There is no customer name, email or address in the
            file.
          </s-text>

          <div>
            <s-button href="/app/export.csv" variant="primary" icon="download" download="sourcetrac-responses.csv">
              Download CSV
            </s-button>
          </div>
        </s-stack>
      </Panel>

      {data.recent.length > 0 ? (
        <Panel title="Preview" description="Your 10 most recent answers, exactly as they will export.">
          <s-table>
            <s-table-header>
              <s-table-header-row>
                {data.headers.map((header) => (
                  <s-table-cell key={header}>{header}</s-table-cell>
                ))}
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {data.recent.map((row) => (
                <s-table-row key={row.orderId}>
                  <s-table-cell>{row.orderId}</s-table-cell>
                  <s-table-cell>{row.submittedAt}</s-table-cell>
                  <s-table-cell>{row.channel}</s-table-cell>
                  <s-table-cell>{row.orderTotal || "—"}</s-table-cell>
                  <s-table-cell>{row.currency || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </Panel>
      ) : null}
    </s-stack>
  );
}