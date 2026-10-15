import { useState } from "react";
import { useLoaderData, useNavigate, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Panel, PageIntro } from "~/components/admin-ui";
import { JustInTimeNotice } from "~/components/data-notice";
import { countChannelAnswers, fetchResponsesInWindow, toExportRows } from "~/lib/analytics-queries.server";
import { toChannelTable, type CsvTable } from "~/lib/csv";
import { createTranslator } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import {
  buildAllSurveysExport,
  buildSurveyExport,
  countSurveyResponses,
  parseExportSelection,
  selectionValue,
} from "~/lib/survey-export.server";
import { listSurveys } from "~/lib/surveys.server";
import { loadExportContext } from "~/lib/export.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { authenticate } from "~/shopify.server";

/**
 * Export page.
 *
 * Pick what to download (every survey, one survey, or the channel file), then
 * one primary action: "Download CSV", fetched with the session token (see
 * `download` below).
 *
 * The page shows the chosen file's columns and newest rows before the merchant
 * commits, because a CSV that does not match expectations is only discovered
 * after it is already open in a spreadsheet.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "export.title");

export const handle = { titleKey: "export.title" };

/** Rows shown in the preview: the newest answers of the chosen file. */
const PREVIEW_RESPONSES = 5;

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  // Orders the webhooks never delivered (placed before install, for one) are
  // fetched in the background (never blocking this page), so their answers stop
  // reading "Pending" on the next load. Bounded and never throws.
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const surveys = await listSurveys(shop.id);
  const selection = parseExportSelection(new URL(request.url).searchParams.get("survey"), surveys);
  const context = await loadExportContext(shop, session);

  // The preview is built by the same code as the download, from the same
  // context, so the values are exactly what the file will contain.
  let count: number;
  let preview: CsvTable;
  if (selection.kind === "channels") {
    const [total, responses] = await Promise.all([
      countChannelAnswers(shop.id),
      fetchResponsesInWindow({ shopId: shop.id, limit: PREVIEW_RESPONSES }),
    ]);
    count = total;
    preview = toChannelTable(toExportRows(responses, context));
  } else {
    const params = {
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      timeZone: context.timeZone,
      t: createTranslator(resolveAdminLanguage(request, shop.language, shop.adminLocale)),
      limit: PREVIEW_RESPONSES,
      order: "newest_first" as const,
    };
    const surveyId = selection.kind === "survey" ? selection.surveyId : undefined;
    const [total, file] = await Promise.all([
      countSurveyResponses(shop.id, surveyId),
      surveyId ? buildSurveyExport({ ...params, surveyId }) : buildAllSurveysExport(params),
    ]);
    count = total;
    preview = { headers: file.headers, rows: file.rows };
  }

  return {
    selection: selectionValue(selection),
    kind: selection.kind,
    surveys: surveys.map((survey) => ({ id: survey.id, name: survey.name })),
    count,
    preview,
  };
});

export default function Export() {
  const data = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [truncatedAt, setTruncatedAt] = useState<string | null>(null);

  /**
   * Fetched rather than linked. Inside the Shopify admin iframe a plain link
   * carries no session token, so the CSV route would answer with a login
   * redirect instead of the file. App Bridge adds the token to `fetch` calls
   * to our own origin; the response is then saved through a blob URL.
   */
  async function download() {
    setDownloading(true);
    setDownloadFailed(false);
    setTruncatedAt(null);
    try {
      const response = await fetch(`/app/export/csv?survey=${encodeURIComponent(data.selection)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // The server says when the file was cut at its row limit; a partial file
      // must not look complete.
      if (response.headers.get("X-SourceTrac-Truncated") === "true") {
        setTruncatedAt(response.headers.get("X-SourceTrac-Row-Limit") ?? "");
      }
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

  const shapeNote =
    data.kind === "all"
      ? t("export.shape_all")
      : data.kind === "survey"
        ? t("export.shape_survey")
        : t("export.shape_channels");
  const [firstHeader, ...otherHeaders] = data.preview.headers;

  return (
    <s-stack gap="base">
      <PageIntro>{t("export.subtitle")}</PageIntro>

      <Panel title={t("export.panel_title")}>
        <s-stack gap="base">
          <s-box maxInlineSize="100%">
            <s-select
              label={t("export.choose_label")}
              value={data.selection}
              onChange={(event) => {
                const next = (event.currentTarget as { value?: unknown }).value;
                if (typeof next === "string" && next !== data.selection) {
                  setTruncatedAt(null);
                  setDownloadFailed(false);
                  navigate(`/app/export?survey=${encodeURIComponent(next)}`);
                }
              }}
            >
              <s-option value="all" selected={data.selection === "all"}>
                {t("export.choose_all")}
              </s-option>
              {data.surveys.map((survey) => (
                <s-option key={survey.id} value={survey.id} selected={survey.id === data.selection}>
                  {survey.name}
                </s-option>
              ))}
              <s-option value="channels" selected={data.selection === "channels"}>
                {t("export.choose_channels")}
              </s-option>
            </s-select>
          </s-box>

          <s-text>
            {data.count === 0 ? t("export.empty_body") : t("export.count_body", { count: data.count })}
          </s-text>
          <s-text color="subdued" fontSize="small">
            {shapeNote}
          </s-text>

          <s-text color="subdued" fontSize="small">
            {/* Column names are the file's literal headers, so they stay as-is. */}
            {t("export.columns_note", { columns: data.preview.headers.join(", ") })}
          </s-text>

          {/* The file leaves SourceTrac with the merchant, so say what is in it. */}
          <JustInTimeNotice>{t("privacy.export_notice")}</JustInTimeNotice>

          <div>
            <s-button variant="primary" icon="download" loading={downloading} onClick={download}>
              {t("export.download")}
            </s-button>
          </div>
          {downloadFailed ? (
            <s-text tone="critical">{t("export.download_failed")}</s-text>
          ) : null}
          {truncatedAt !== null ? (
            <s-text tone="warning">{t("export.truncated", { limit: truncatedAt })}</s-text>
          ) : null}
        </s-stack>
      </Panel>

      {data.preview.rows.length > 0 && firstHeader !== undefined ? (
        <Panel
          title={t("export.preview_title")}
          description={t("export.preview_description", { count: data.preview.rows.length })}
        >
          {/* Column headers are `s-table-header` with list slots, so a phone
              gets one card per row (the first column on top, the rest as
              labelled pairs) instead of columns scrolling sideways. Header
              text is the file's literal column name. */}
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{firstHeader}</s-table-header>
              {otherHeaders.map((header, index) => (
                <s-table-header key={`${index}-${header}`} listSlot="labeled">
                  {header}
                </s-table-header>
              ))}
            </s-table-header-row>
            <s-table-body>
              {data.preview.rows.map((cells, rowIndex) => (
                <s-table-row key={rowIndex}>
                  {cells.map((cell, cellIndex) => (
                    <s-table-cell key={cellIndex}>{cell || "—"}</s-table-cell>
                  ))}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </Panel>
      ) : null}
    </s-stack>
  );
}
