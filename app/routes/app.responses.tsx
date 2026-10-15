import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Panel, PageIntro } from "~/components/admin-ui";
import { SurveyPicker } from "~/components/survey-picker";
import { orderAdminLink, resolveExportTimeZone, type RevenueStatus } from "~/lib/csv";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { currentOrderTotal, fetchSurveyResponses, surveyRevenueStatus } from "~/lib/survey-analytics.server";
import { getShopLocaleInfo } from "~/lib/studio.server";
import { getSurveyRow, listSurveys } from "~/lib/surveys.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Responses — one row per buyer answer, for the new multi-question surveys.
 *
 * The read-only record of what was collected: order, when, where and what was
 * answered. The revenue status is the same decision the CSV and Results page
 * make, so a row marked "counted" is exactly what those sum.
 *
 * No customer name, email, phone or address is stored, so none can appear here.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "responses.title");

export const handle = { titleKey: "responses.title" };

const PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;
  // A whole page number within a sane range: `?page=1.01` or a huge value used
  // to reach Prisma as a fractional or overflowing offset and fail with a 500.
  const page = Math.min(MAX_PAGE, Math.max(0, Math.floor(Number(url.searchParams.get("page") ?? "0") || 0)));

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));

  if (!selectedId) {
    return { surveys: [], selected: null, rows: [], page: 0, hasMore: false, labels: {}, timeZone: "UTC" };
  }

  const row = await getSurveyRow(shop.id, selectedId);
  const labels = new Map<string, string>();
  for (const question of row?.questions ?? []) {
    for (const option of question.options) labels.set(option.id, option.label);
  }

  // Times are shown in the shop's own zone, like the CSV, and labelled with it.
  const { timeZone: shopZone } = await getShopLocaleInfo(shop.id, shop.shopDomain, session.accessToken);
  const timeZone = resolveExportTimeZone(shopZone);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone });

  const responses = await fetchSurveyResponses({
    shopId: shop.id,
    surveyId: selectedId,
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  });
  const hasMore = responses.length > PAGE_SIZE;
  const slice = responses.slice(0, PAGE_SIZE);

  return {
    surveys: surveys.map((s) => ({ id: s.id, name: s.name, responseCount: s.responseCount })),
    selected: selectedId,
    page,
    hasMore,
    timeZone,
    labels: Object.fromEntries(labels),
    rows: slice.map((response) => {
      const status = surveyRevenueStatus(response);
      const total = currentOrderTotal(response);
      const answers = response.answers.map((answer) => {
        const parts: string[] = [];
        for (const optionId of answer.optionIds) parts.push(labels.get(optionId) ?? optionId);
        if (answer.otherText) parts.push(answer.otherText);
        if (typeof answer.numberValue === "number") parts.push(String(answer.numberValue));
        if (answer.textValue) parts.push(answer.textValue);
        return { questionId: answer.questionId, text: parts.join(", ") };
      });

      return {
        id: response.id,
        orderId: response.orderId,
        orderName: response.orderNumber,
        orderLink: response.orderId ? orderAdminLink(shop.shopDomain, response.orderId) : null,
        submittedAt: when.format(response.createdAt),
        placement: response.placement,
        total: total?.total ?? null,
        currency: total?.currency ?? null,
        counted: status === "counted",
        /** i18n key suffix for the status cell. */
        status: STATUS_KEY[status],
        answers,
      };
    }),
  };
});

const STATUS_KEY: Record<RevenueStatus, string> = {
  counted: "counted",
  "awaiting order": "awaiting_order",
  "order not received": "order_not_received",
  "test order": "test_order",
  cancelled: "cancelled",
  voided: "voided",
  refunded: "refunded",
  "total unreadable": "total_unreadable",
  "no order": "no_order",
};

/**
 * Colour for an answer's revenue status: green when it counts, blue while the
 * order is on its way, grey for the rest (test, cancelled, refunded...), which
 * are expected outcomes rather than problems.
 */
function statusTone(status: string): "success" | "info" | "neutral" {
  if (status === "counted") return "success";
  if (status === "awaiting_order") return "info";
  return "neutral";
}

export default function Responses() {
  const data = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();

  if (!data.selected) {
    return (
      <s-stack gap="base">
        <PageIntro>{t("responses.subtitle")}</PageIntro>
        <Panel title={t("responses.empty_title")}>
          <s-text>{t("responses.empty_body")}</s-text>
        </Panel>
      </s-stack>
    );
  }

  return (
    <s-stack gap="base">
      <PageIntro
        actions={
          <s-button href="/app/export" icon="export">
            {t("responses.export_cta")}
          </s-button>
        }
      >
        {t("responses.subtitle")}
      </PageIntro>

      <SurveyPicker
        surveys={data.surveys}
        selected={data.selected}
        basePath="/app/responses"
        label={t("responses.survey_label")}
      />

      <Panel title={t("responses.table_title")}>
        {data.rows.length === 0 ? (
          <s-text color="subdued">{t("responses.none_yet")}</s-text>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("responses.col_order")}</s-table-header>
              <s-table-header listSlot="secondary">{`${t("responses.col_when")} (${data.timeZone})`}</s-table-header>
              <s-table-header listSlot="labeled">{t("responses.col_where")}</s-table-header>
              <s-table-header listSlot="labeled">{t("responses.col_answer")}</s-table-header>
              <s-table-header listSlot="labeled">{t("responses.col_total")}</s-table-header>
              <s-table-header listSlot="labeled">{t("responses.col_status")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    {row.orderLink ? (
                      <s-link href={row.orderLink} target="_blank">
                        {row.orderName ?? (row.orderId ?? "—")}
                      </s-link>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>{row.submittedAt}</s-table-cell>
                  <s-table-cell>{t(`surveys.placement_${row.placement}`)}</s-table-cell>
                  <s-table-cell>{row.answers.map((a) => a.text).filter(Boolean).join(" · ") || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">
                      {row.total ? `${row.total} ${row.currency ?? ""}`.trim() : "—"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(row.status)}>{t(`responses.status_${row.status}`)}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </Panel>

      {data.page > 0 || data.hasMore ? (
        <s-stack direction="inline" gap="small">
          {data.page > 0 ? (
            <s-button href={`/app/responses?survey=${data.selected}&page=${data.page - 1}`}>
              {t("responses.previous")}
            </s-button>
          ) : null}
          {data.hasMore ? (
            <s-button href={`/app/responses?survey=${data.selected}&page=${data.page + 1}`}>
              {t("responses.next")}
            </s-button>
          ) : null}
        </s-stack>
      ) : null}
    </s-stack>
  );
}
