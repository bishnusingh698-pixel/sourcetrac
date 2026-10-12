import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { useState } from "react";

import { Banner, MoneyList, Panel } from "~/components/admin-ui";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { buildBreakdowns, fetchSurveyResponses, summariseSurvey } from "~/lib/survey-analytics.server";
import { listSurveys, getSurveyRow } from "~/lib/surveys.server";
import { formatMoney } from "~/lib/money";
import { ensureShop } from "~/lib/provision.server";
import { backfillMissingOrders } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Results — aggregated answers for the new multi-question surveys.
 *
 * This is the reporting counterpart to the dashboard's channel report. It reads
 * the new `Response` / `Answer` tables; the dashboard keeps reading the old
 * `SurveyResponse` table so both work through the transition.
 *
 * No money is summed across currencies here: every revenue figure carries its
 * own currency, formatted server-side.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "results.title");

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  await backfillMissingOrders({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));
  const amount = (minor: number, currency: string) => formatMoney(minor, currency, locale);

  if (!selectedId) {
    return { surveys: [], selected: null, summary: null, breakdowns: [], questions: [], amount };
  }

  const row = await getSurveyRow(shop.id, selectedId);
  const responses = await fetchSurveyResponses({ shopId: shop.id, surveyId: selectedId });
  const summary = summariseSurvey(responses);
  const questions = (row?.questions ?? []).map((q) => ({
    id: q.id,
    text: q.text,
    type: q.type,
    options: q.options.map((o) => ({ id: o.id, label: o.label, archived: o.archived })),
  }));
  const breakdowns = buildBreakdowns({ responses, questions });

  const optionLabel = new Map<string, string>();
  for (const question of questions) {
    for (const option of question.options) optionLabel.set(option.id, option.label);
  }

  return {
    surveys: surveys.map((s) => ({ id: s.id, name: s.name, responseCount: s.responseCount })),
    selected: selectedId,
    summary,
    questions,
    optionLabel: Object.fromEntries(optionLabel),
    breakdowns: breakdowns.map((breakdown) => {
      if (breakdown.kind === "choice") {
        return {
          kind: "choice" as const,
          questionId: breakdown.questionId,
          total: breakdown.total,
          otherCount: breakdown.otherCount,
          options: breakdown.options.map((option) => ({
            optionId: option.optionId,
            count: option.count,
            revenue: option.revenueByCurrency.map((entry) => ({
              currency: entry.currency,
              text: amount(entry.minor, entry.currency),
            })),
          })),
        };
      }
      if (breakdown.kind === "numeric") {
        return { kind: "numeric" as const, questionId: breakdown.questionId, total: breakdown.total, distribution: breakdown.distribution };
      }
      return {
        kind: "text" as const,
        questionId: breakdown.questionId,
        total: breakdown.total,
        answers: breakdown.answers.map((a) => ({
          text: a.text,
          otherText: a.otherText,
          when: a.createdAt.toISOString(),
        })),
      };
    }),
    amount,
  };
});

export default function Results() {
  const data = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch(`/app/results/csv?survey=${data.selected}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "sourcetrac-results.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      // A failed download has no inline error slot; the button simply re-enables.
    } finally {
      setDownloading(false);
    }
  }

  if (data.surveys.length === 0 || !data.selected || !data.summary) {
    return (
      <s-stack gap="base">
        <s-section heading={t("results.title")} subheading={t("results.subtitle")} padding="none" />
        <Banner tone="info" heading={t("results.empty_title")}>
          {t("results.empty_body")}
        </Banner>
      </s-stack>
    );
  }

  const summary = data.summary;
  const questionById = new Map(data.questions.map((q) => [q.id, q]));

  return (
    <s-stack gap="base">
      <s-section heading={t("results.title")} subheading={t("results.subtitle")} padding="none" />

      <s-stack direction="inline" gap="small">
        <s-button icon="download" loading={downloading} onClick={download}>
          {t("results.download")}
        </s-button>
      </s-stack>

      {data.surveys.length > 1 ? (
        <s-stack direction="inline" gap="small">
          {data.surveys.map((survey) => (
            <s-button
              key={survey.id}
              href={`/app/results?survey=${survey.id}`}
              variant={survey.id === data.selected ? "primary" : "secondary"}
            >
              {survey.name}
            </s-button>
          ))}
        </s-stack>
      ) : null}

      <Panel title={t("results.summary_title")}>
        <s-stack direction="inline" gap="base">
          <s-stack gap="small-200">
            <s-text type="strong" fontSize="small">
              {t("results.total")}
            </s-text>
            <s-heading>{String(summary.totalResponses)}</s-heading>
          </s-stack>
          <s-stack gap="small-200">
            <s-text type="strong" fontSize="small">
              {t("results.pending")}
            </s-text>
            <s-heading>{String(summary.pendingResponses)}</s-heading>
          </s-stack>
          <s-stack gap="small-200">
            <s-text type="strong" fontSize="small">
              {t("results.revenue")}
            </s-text>
            <MoneyList
              amounts={summary.revenueByCurrency.map((entry) => ({
                currency: entry.currency,
                text: data.amount(entry.minor, entry.currency),
              }))}
            />
          </s-stack>
        </s-stack>
      </Panel>

      {data.breakdowns.map((breakdown) => {
        const question = questionById.get(breakdown.questionId);
        const title = question?.text ?? breakdown.questionId;

        if (breakdown.kind === "choice") {
          const max = Math.max(1, ...breakdown.options.map((o) => o.count));
          return (
            <Panel key={breakdown.questionId} title={title} description={t("results.answered", { count: breakdown.total })}>
              <s-stack gap="small">
                {breakdown.options.map((option) => (
                  <s-stack key={option.optionId} gap="small-200">
                    <s-stack direction="inline" justifyContent="space-between" gap="small">
                      <s-text type="strong">
                        {data.optionLabel[option.optionId] ?? option.optionId}
                        {question?.options.find((o) => o.id === option.optionId)?.archived
                          ? ` ${t("results.removed")}`
                          : ""}
                      </s-text>
                      <s-text fontVariantNumeric="tabular-nums">{String(option.count)}</s-text>
                    </s-stack>
                    <s-progress value={Math.round((option.count / max) * 100)} max={100} />
                    {option.revenue.length > 0 ? (
                      <MoneyList
                        amounts={option.revenue.map((entry) => ({
                          currency: entry.currency,
                          text: entry.text,
                        }))}
                      />
                    ) : null}
                  </s-stack>
                ))}
              </s-stack>
            </Panel>
          );
        }

        if (breakdown.kind === "numeric") {
          const max = Math.max(1, ...breakdown.distribution.map((d) => d.count));
          return (
            <Panel key={breakdown.questionId} title={title} description={t("results.answered", { count: breakdown.total })}>
              <s-stack gap="small">
                {breakdown.distribution.map((bucket) => (
                  <s-stack key={bucket.value} direction="inline" gap="small" alignItems="center">
                    <s-text fontVariantNumeric="tabular-nums" type="strong">
                      {String(bucket.value)}
                    </s-text>
                    <s-box>
                      <s-progress value={Math.round((bucket.count / max) * 100)} max={100} />
                    </s-box>
                    <s-text fontVariantNumeric="tabular-nums">{String(bucket.count)}</s-text>
                  </s-stack>
                ))}
              </s-stack>
            </Panel>
          );
        }

        return (
          <Panel key={breakdown.questionId} title={title} description={t("results.answered", { count: breakdown.total })}>
            {breakdown.answers.length === 0 ? (
              <s-text color="subdued">{t("results.no_text_answers")}</s-text>
            ) : (
              <s-stack gap="small">
                {breakdown.answers.map((a, index) => (
                  <s-box key={index} padding="small" border="base" borderRadius="base">
                    <s-text>{a.otherText || a.text}</s-text>
                  </s-box>
                ))}
              </s-stack>
            )}
          </Panel>
        );
      })}
    </s-stack>
  );
}
