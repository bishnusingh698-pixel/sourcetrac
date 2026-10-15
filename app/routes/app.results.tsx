import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { useState } from "react";

import { Banner, MoneyList, Panel, PageIntro, Metric, BigNumber } from "~/components/admin-ui";
import { SurveyPicker } from "~/components/survey-picker";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import {
  buildBreakdowns,
  fetchSurveyResponses,
  RESULTS_RESPONSE_LIMIT,
  summariseSurvey,
} from "~/lib/survey-analytics.server";
import { fixedOptionLabel } from "~/lib/answer-text";
import type { TFunction } from "~/lib/i18n";
import type { QuestionScore } from "~/lib/survey-analytics.server";
import { listSurveys, getSurveyRow } from "~/lib/surveys.server";
import { formatMoney } from "~/lib/money";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
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

export const handle = { titleKey: "results.title" };

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));
  const amount = (minor: number, currency: string) => formatMoney(minor, currency, locale);

  if (!selectedId) {
    return { surveys: [], selected: null, summary: null, revenue: [], breakdowns: [], questions: [], capped: null };
  }

  const row = await getSurveyRow(shop.id, selectedId);
  // Bounded: the newest answers only, and the page says so when it is capped.
  const responses = await fetchSurveyResponses({
    shopId: shop.id,
    surveyId: selectedId,
    limit: RESULTS_RESPONSE_LIMIT + 1,
  });
  const capped = responses.length > RESULTS_RESPONSE_LIMIT ? RESULTS_RESPONSE_LIMIT : null;
  if (capped !== null) responses.length = RESULTS_RESPONSE_LIMIT;
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
    capped,
    // Formatted here: a function in loader data never reaches the browser.
    revenue: summary.revenueByCurrency.map((entry) => ({
      currency: entry.currency,
      text: amount(entry.minor, entry.currency),
    })),
    questions,
    optionLabel: Object.fromEntries(optionLabel),
    breakdowns: breakdowns.map((breakdown) => {
      if (breakdown.kind === "choice") {
        return {
          kind: "choice" as const,
          questionId: breakdown.questionId,
          total: breakdown.total,
          otherCount: breakdown.otherCount,
          multiple: breakdown.multiple,
          score: breakdown.score,
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
        return {
          kind: "numeric" as const,
          questionId: breakdown.questionId,
          total: breakdown.total,
          distribution: breakdown.distribution,
          score: breakdown.score,
        };
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
  };
});

export default function Results() {
  const data = useLoaderData<typeof loader>();
  const { t, locale } = useAdminI18n();
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  async function download() {
    setDownloading(true);
    setDownloadFailed(false);
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
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  if (data.surveys.length === 0 || !data.selected || !data.summary) {
    return (
      <s-stack gap="base">
        <PageIntro>{t("results.subtitle")}</PageIntro>
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
      <PageIntro
        actions={
          <s-button icon="download" loading={downloading} onClick={download}>
            {t("results.download")}
          </s-button>
        }
      >
        {t("results.subtitle")}
      </PageIntro>
      {downloadFailed ? (
        <Banner tone="critical" heading={t("results.download_failed")} />
      ) : null}

      {data.capped !== null ? (
        <s-text color="subdued">{t("results.capped_note", { limit: data.capped })}</s-text>
      ) : null}

      <SurveyPicker
        surveys={data.surveys}
        selected={data.selected}
        basePath="/app/results"
        label={t("responses.survey_label")}
      />

      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 560px) repeat(3, minmax(0, 1fr)), minmax(0, 1fr)"
          gap="base"
        >
          <Metric label={t("results.revenue")}>
            <MoneyList amounts={data.revenue} size="large" tone="success" />
          </Metric>
          <Metric label={t("results.total")}>
            <BigNumber>{summary.totalResponses}</BigNumber>
          </Metric>
          <Metric label={t("results.pending")}>
            <BigNumber>{summary.pendingResponses}</BigNumber>
          </Metric>
        </s-grid>
      </s-query-container>

      {data.breakdowns.map((breakdown) => {
        const question = questionById.get(breakdown.questionId);
        const title = question?.text ?? breakdown.questionId;

        if (breakdown.kind === "choice") {
          const max = Math.max(1, ...breakdown.options.map((o) => o.count));
          return (
            <Panel key={breakdown.questionId} title={title} description={t("results.answered", { count: breakdown.total })}>
              <s-stack gap="small">
                {breakdown.score ? <ScoreBlock score={breakdown.score} locale={locale} t={t} /> : null}
                {breakdown.options.map((option) => (
                  <s-stack key={option.optionId} gap="small-200">
                    <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
                      <s-text type="strong">
                        {data.optionLabel[option.optionId] ?? fixedOptionLabel(option.optionId, t) ?? option.optionId}
                        {question?.options.find((o) => o.id === option.optionId)?.archived
                          ? ` ${t("results.removed")}`
                          : ""}
                      </s-text>
                      <s-text fontVariantNumeric="tabular-nums">{String(option.count)}</s-text>
                    </s-grid>
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
                {breakdown.multiple ? (
                  <s-text color="subdued" fontSize="small">
                    {t("results.multi_credit_note")}
                  </s-text>
                ) : null}
              </s-stack>
            </Panel>
          );
        }

        if (breakdown.kind === "numeric") {
          const max = Math.max(1, ...breakdown.distribution.map((d) => d.count));
          return (
            <Panel key={breakdown.questionId} title={title} description={t("results.answered", { count: breakdown.total })}>
              <s-stack gap="small">
                {breakdown.score ? <ScoreBlock score={breakdown.score} locale={locale} t={t} /> : null}
                {breakdown.distribution.map((bucket) => (
                  <s-grid key={bucket.value} gridTemplateColumns="2.5rem minmax(0, 1fr) auto" gap="small" alignItems="center">
                    <s-text fontVariantNumeric="tabular-nums" type="strong">
                      {String(bucket.value)}
                    </s-text>
                    <s-progress value={Math.round((bucket.count / max) * 100)} max={100} />
                    <s-text fontVariantNumeric="tabular-nums">{String(bucket.count)}</s-text>
                  </s-grid>
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

/**
 * The headline score for an NPS, rating or satisfaction question, with what it
 * is made of. NPS shows the promoter / passive / detractor split; CSAT shows
 * the satisfied share and the average. Only shown once a question has answers,
 * so there is never a fabricated 0.
 */
function ScoreBlock({ score, locale, t }: { score: QuestionScore; locale: string; t: TFunction }) {
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const percentOf = (count: number) => (score.total > 0 ? Math.round((count / score.total) * 100) : 0);

  if (score.kind === "nps") {
    const signed = score.score > 0 ? `+${number(score.score)}` : number(score.score);
    const rows: Array<{ label: string; count: number; tone: "success" | "neutral" | "critical" }> = [
      { label: t("results.score_promoters"), count: score.promoters, tone: "success" },
      { label: t("results.score_passives"), count: score.passives, tone: "neutral" },
      { label: t("results.score_detractors"), count: score.detractors, tone: "critical" },
    ];
    return (
      <s-box padding="base" background="subdued" borderRadius="base">
        <s-stack gap="small">
          <s-stack gap="small-300">
            <s-text type="strong">{t("results.score_nps")}</s-text>
            <BigNumber>{signed}</BigNumber>
            <s-text color="subdued" fontSize="small">
              {t("results.score_nps_help")} {t("results.score_based_on", { count: score.total })}
            </s-text>
          </s-stack>
          {rows.map((row) => (
            <s-stack key={row.label} gap="small-300">
              <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
                <s-text>{row.label}</s-text>
                <s-text fontVariantNumeric="tabular-nums">
                  {t("results.score_share", { percent: number(percentOf(row.count)), count: number(row.count) })}
                </s-text>
              </s-grid>
              <s-progress value={percentOf(row.count)} max={100} tone={row.tone} />
            </s-stack>
          ))}
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-300">
        <s-text type="strong">{t("results.score_csat")}</s-text>
        <BigNumber>{t("results.score_share_percent", { percent: number(score.percent) })}</BigNumber>
        <s-text>{t("results.score_average", { average: number(score.average, 1) })}</s-text>
        <s-text color="subdued" fontSize="small">
          {t("results.score_csat_help")} {t("results.score_based_on", { count: score.total })}
        </s-text>
      </s-stack>
    </s-box>
  );
}
