import { useState } from "react";
import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Panel } from "~/components/admin-ui";
import { fetchResponsesInWindow, toExportRows } from "~/lib/analytics-queries.server";
import { CSV_HEADERS } from "~/lib/csv";
import { db } from "~/db.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
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

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "export.title");

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const count = await db.surveyResponse.count({ where: { shopId: shop.id } });

  // A preview of the newest rows, so merchants can confirm the file looks right
  // before downloading. Values are shown exactly as they will be written.
  const recent = toExportRows(await fetchResponsesInWindow({ shopId: shop.id, limit: 10 }));

  return {
    count,
    headers: [...CSV_HEADERS],
    recent: recent.map((row) => ({
      orderId: row.orderId,
      submittedAt: row.submittedAt.toISOString(),
      channel: row.channel,
      // Same builder the CSV route uses, so the preview is byte-identical to
      // the file and to the dashboard's revenue decision.
      orderTotal: row.orderTotal ?? "",
      currency: row.currency ?? "",
    })),
  };
});

export default function Export() {
  const data = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  /**
   * Fetched rather than linked. Inside the Shopify admin iframe a plain link
   * carries no session token, so the CSV route would answer with a login
   * redirect instead of the file. App Bridge adds the token to `fetch` calls
   * to our own origin; the response is then saved through a blob URL.
   */
  async function download() {
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const response = await fetch("/app/export/csv");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "sourcetrac-responses.csv";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <s-stack gap="base">
      <s-section heading={t("export.title")} subheading={t("export.subtitle")} padding="none" />

      <Panel title={t("export.panel_title")}>
        <s-stack gap="base">
          <s-text>
            {data.count === 0 ? t("export.empty_body") : t("export.count_body", { count: data.count })}
          </s-text>

          <s-text color="subdued" fontSize="small">
            {/* Column names are the file's literal headers, so they stay as-is. */}
            {t("export.columns_note", { columns: data.headers.join(", ") })}
          </s-text>

          <div>
            <s-button variant="primary" icon="download" loading={downloading} onClick={download}>
              {t("export.download")}
            </s-button>
          </div>
          {downloadFailed ? (
            <s-text tone="critical">{t("export.download_failed")}</s-text>
          ) : null}
        </s-stack>
      </Panel>

      {data.recent.length > 0 ? (
        <Panel
          title={t("export.preview_title")}
          description={t("export.preview_description", { count: data.recent.length })}
        >
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