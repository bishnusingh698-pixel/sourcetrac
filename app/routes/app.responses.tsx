import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Panel } from "~/components/admin-ui";
import { orderAdminLink } from "~/lib/csv";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { decideSurveyRevenue, fetchSurveyResponses } from "~/lib/survey-analytics.server";
import { getSurveyRow, listSurveys } from "~/lib/surveys.server";
import { formatDecimalForCurrency } from "~/lib/money";
import { ensureShop } from "~/lib/provision.server";
import { backfillMissingOrders } from "~/lib/order-backfill.server";
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

const PAGE_SIZE = 50;

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  await backfillMissingOrders({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;
  const page = Math.max(0, Number(url.searchParams.get("page") ?? "0") || 0);

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));

  if (!selectedId) {
    return { surveys: [], selected: null, rows: [], page: 0, hasMore: false, labels: {} };
  }

  const row = await getSurveyRow(shop.id, selectedId);
  const labels = new Map<string, string>();
  for (const question of row?.questions ?? []) {
    for (const option of question.options) labels.set(option.id, option.label);
  }

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
    labels: Object.fromEntries(labels),
    rows: slice.map((response) => {
      const decision = decideSurveyRevenue(response);
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
        submittedAt: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          response.createdAt,
        ),
        placement: response.placement,
        total:
          response.orderTotal !== null && response.currency
            ? formatDecimalForCurrency(response.orderTotal, response.currency)
            : null,
        currency: response.currency,
        counted: decision.included,
        reason: decision.included ? null : decision.reason,
        answers,
      };
    }),
  };
});

export default function Responses() {
  const data = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();

  if (!data.selected) {
    return (
      <s-stack gap="base">
        <s-section heading={t("responses.title")} subheading={t("responses.subtitle")} padding="none" />
        <Panel title={t("responses.empty_title")}>
          <s-text>{t("responses.empty_body")}</s-text>
        </Panel>
      </s-stack>
    );
  }

  return (
    <s-stack gap="base">
      <s-section heading={t("responses.title")} subheading={t("responses.subtitle")} padding="none" />

      {data.surveys.length > 1 ? (
        <s-stack direction="inline" gap="small">
          {data.surveys.map((survey) => (
            <s-button
              key={survey.id}
              href={`/app/responses?survey=${survey.id}`}
              variant={survey.id === data.selected ? "primary" : "secondary"}
            >
              {survey.name}
            </s-button>
          ))}
        </s-stack>
      ) : null}

      <Panel title={t("responses.table_title")}>
        {data.rows.length === 0 ? (
          <s-text color="subdued">{t("responses.none_yet")}</s-text>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("responses.col_order")}</s-table-header>
              <s-table-header listSlot="secondary">{t("responses.col_when")}</s-table-header>
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
                  <s-table-cell>{row.total ? `${row.total} ${row.currency ?? ""}`.trim() : "—"}</s-table-cell>
                  <s-table-cell>{row.counted ? t("responses.counted") : t("responses.not_counted")}</s-table-cell>
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
