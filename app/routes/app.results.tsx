import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { useState } from "react";

import { Banner, MoneyList, Panel, PageIntro, Metric, BigNumber } from "~/components/admin-ui";
import { SurveyPicker } from "~/components/survey-picker";
import { ScoreBlock, scoreValueText } from "~/components/scores";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import {
  answerRatePercent,
  aovMinor,
  buildBreakdowns,
  fetchSurveyResponses,
  RESULTS_RESPONSE_LIMIT,
  summariseSurvey,
  surveyAnswerRates,
  type BuyerGroup,
  type CurrencyTotal,
} from "~/lib/survey-analytics.server";
import { windowBounds } from "~/lib/analytics";
import { fixedOptionLabel } from "~/lib/answer-text";
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

/** Date ranges, as on the channel report, plus all time. */
const RANGES = [
  { key: "7", days: 7, labelKey: "dashboard.last_7" },
  { key: "30", days: 30, labelKey: "dashboard.last_30" },
  { key: "90", days: 90, labelKey: "dashboard.last_90" },
  { key: "all", days: null, labelKey: "results.all_time" },
] as const;

type Range = (typeof RANGES)[number];

function parseRange(value: string | null): Range {
  return RANGES.find((range) => range.key === value) ?? RANGES[3];
}

/**
 * The newest answers across every survey that the comparison table reads. A
 * shop at the top of the target size answers a few thousand orders a month,
 * so 90 days sits well inside it; above it the page says the table is partial.
 */
const COMPARE_RESPONSE_LIMIT = 20_000;

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));
  const amount = (minor: number, currency: string) => formatMoney(minor, currency, locale);
  // Formatted here: a function in loader data never reaches the browser.
  const money = (totals: ReadonlyArray<CurrencyTotal>) =>
    totals.map((entry) => ({ currency: entry.currency, text: amount(entry.minor, entry.currency) }));
  const aov = (totals: ReadonlyArray<CurrencyTotal>) =>
    totals.flatMap((entry) => {
      const value = aovMinor(entry);
      return value === null ? [] : [{ currency: entry.currency, text: amount(value, entry.currency) }];
    });

  if (!selectedId) {
    return {
      range: range.key,
      surveys: [],
      compare: [],
      compareCapped: false,
      selected: null,
      summary: null,
      answerRate: null,
      revenue: [],
      aov: [],
      buyers: null,
      breakdowns: [],
      questions: [],
      capped: null,
    };
  }

  const now = new Date();
  const window = range.days === null ? { start: null, end: now } : windowBounds(range.days, now);
  const inWindow = { ...(window.start ? { start: window.start } : {}), end: window.end };

  const row = await getSurveyRow(shop.id, selectedId);
  // Bounded: the newest answers only, and the page says so when it is capped.
  const [responses, everyResponse, rates] = await Promise.all([
    fetchSurveyResponses({ shopId: shop.id, surveyId: selectedId, ...inWindow, limit: RESULTS_RESPONSE_LIMIT + 1 }),
    surveys.length > 1
      ? fetchSurveyResponses({ shopId: shop.id, ...inWindow, limit: COMPARE_RESPONSE_LIMIT + 1 })
      : Promise.resolve(null),
    surveyAnswerRates({
      shopId: shop.id,
      surveys: surveys.map((s) => ({ id: s.id, createdAt: new Date(s.createdAt) })),
      start: window.start,
      end: window.end,
    }),
  ]);
  const capped = responses.length > RESULTS_RESPONSE_LIMIT ? RESULTS_RESPONSE_LIMIT : null;
  if (capped !== null) responses.length = RESULTS_RESPONSE_LIMIT;
  const summary = summariseSurvey(responses);
  const questions = (row?.questions ?? []).map((q) => ({
    id: q.id,
    text: q.text,
    type: q.type,
    allowOther: q.allowOther,
    options: q.options.map((o) => ({ id: o.id, label: o.label, archived: o.archived, isOther: o.isOther })),
  }));
  const breakdowns = buildBreakdowns({ responses, questions });

  const optionLabel = new Map<string, string>();
  for (const question of questions) {
    for (const option of question.options) optionLabel.set(option.id, option.label);
  }

  // Every survey side by side, in the same range, from the same revenue rule.
  const compareCapped = everyResponse !== null && everyResponse.length > COMPARE_RESPONSE_LIMIT;
  if (everyResponse && compareCapped) everyResponse.length = COMPARE_RESPONSE_LIMIT;
  const bySurvey = new Map<string, typeof responses>();
  for (const response of everyResponse ?? []) {
    const list = bySurvey.get(response.surveyId) ?? [];
    list.push(response);
    bySurvey.set(response.surveyId, list);
  }
  const compare =
    everyResponse === null
      ? []
      : surveys.map((survey) => {
          const stats = summariseSurvey(bySurvey.get(survey.id) ?? []);
          return {
            id: survey.id,
            name: survey.name,
            status: survey.status,
            responses: stats.totalResponses,
            answerRate: answerRatePercent(rates.get(survey.id)),
            revenue: money(stats.revenueByCurrency),
            aov: aov(stats.revenueByCurrency),
          };
        });

  const buyerGroup = (group: BuyerGroup) => ({
    responses: group.responses,
    revenue: money(group.revenueByCurrency),
    aov: aov(group.revenueByCurrency),
  });

  return {
    range: range.key,
    surveys: surveys.map((s) => ({ id: s.id, name: s.name, responseCount: s.responseCount })),
    compare,
    compareCapped,
    selected: selectedId,
    // Only the counts the page shows: money goes out formatted (below), never
    // as raw minor units for the browser to misread.
    summary: {
      totalResponses: summary.totalResponses,
      pendingResponses: summary.pendingResponses,
      countedOrders: summary.revenueByCurrency.reduce((sum, entry) => sum + entry.orders, 0),
    },
    answerRate: answerRatePercent(rates.get(selectedId)),
    capped,
    revenue: money(summary.revenueByCurrency),
    aov: aov(summary.revenueByCurrency),
    buyers: {
      first: buyerGroup(summary.buyers.first),
      returning: buyerGroup(summary.buyers.returning),
      unknown: summary.buyers.unknown,
    },
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
            percent: breakdown.total > 0 ? Math.round((option.count / breakdown.total) * 100) : 0,
            revenue: money(option.revenueByCurrency),
            aov: aov(option.revenueByCurrency),
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
      const response = await fetch(
        `/app/results/csv?survey=${encodeURIComponent(data.selected ?? "")}&range=${encodeURIComponent(data.range)}`,
      );
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

  if (data.surveys.length === 0 || !data.selected || !data.summary || !data.buyers) {
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
  const buyers = data.buyers;
  const questionById = new Map(data.questions.map((q) => [q.id, q]));
  const rangeQuery = `range=${encodeURIComponent(data.range)}`;
  const rangeLabel = t(RANGES.find((range) => range.key === data.range)?.labelKey ?? "results.all_time");
  const percent = (value: number) => t("results.cross_percent", { percent: value });
  const knownBuyers = buyers.first.responses + buyers.returning.responses;
  // The survey's headline scores, as tiles beside its other numbers: the first
  // NPS question and the first rating / satisfaction question that have
  // answers. Each question's full split is in its own panel below.
  const headlineScores = (["nps", "csat"] as const).flatMap((kind) => {
    const score = data.breakdowns.find((b) => b.kind !== "text" && b.score?.kind === kind);
    return score && score.kind !== "text" && score.score ? [score.score] : [];
  });

  return (
    <s-stack gap="base">
      <PageIntro
        actions={
          <s-stack direction="inline" gap="small">
            {/* Every single answer, one by one: the Responses page left
                Shopify's sidebar, so Results is where merchants look for it. */}
            <s-button href={data.selected ? `/app/responses?survey=${data.selected}` : "/app/responses"} icon="chat">
              {t("results.see_answers")}
            </s-button>
            <s-button icon="download" loading={downloading} onClick={download}>
              {t("results.download")}
            </s-button>
          </s-stack>
        }
      >
        {t("results.subtitle")}
      </PageIntro>
      {downloadFailed ? (
        <Banner tone="critical" heading={t("results.download_failed")} />
      ) : null}

      {/* An inline stack, not a button group: a group never wraps, and four
          ranges in French or German are wider than a phone. */}
      <div role="group" aria-label={t("dashboard.range_label")}>
        <s-stack direction="inline" gap="small-200">
          {RANGES.map((range) => (
            <s-button
              key={range.key}
              href={`/app/results?survey=${encodeURIComponent(data.selected ?? "")}&range=${range.key}`}
              variant={range.key === data.range ? "primary" : "secondary"}
            >
              {t(range.labelKey)}
            </s-button>
          ))}
        </s-stack>
      </div>

      {data.compare.length > 0 ? (
        <Panel title={t("results.compare_title")} description={t("results.compare_description", { range: rangeLabel })}>
          <s-stack gap="small">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("results.compare_survey")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("results.total")}</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">{t("results.answer_rate")}</s-table-header>
                <s-table-header listSlot="labeled" format="currency">{t("results.revenue")}</s-table-header>
                <s-table-header listSlot="labeled" format="currency">{t("results.aov")}</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.compare.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      <s-link href={`/app/results?survey=${encodeURIComponent(row.id)}&${rangeQuery}`}>
                        {row.id === data.selected ? `${row.name} ✓` : row.name}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{String(row.responses)}</s-table-cell>
                    <s-table-cell>{row.answerRate === null ? "—" : percent(row.answerRate)}</s-table-cell>
                    <s-table-cell>
                      <MoneyList amounts={row.revenue} />
                    </s-table-cell>
                    <s-table-cell>
                      <MoneyList amounts={row.aov} />
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {data.compareCapped ? (
              <s-text color="subdued" fontSize="small">
                {t("results.compare_capped", { limit: new Intl.NumberFormat(locale).format(COMPARE_RESPONSE_LIMIT) })}
              </s-text>
            ) : null}
          </s-stack>
        </Panel>
      ) : null}

      <SurveyPicker
        surveys={data.surveys}
        selected={data.selected}
        basePath="/app/results"
        query={{ range: data.range }}
        label={t("responses.survey_label")}
      />

      {data.capped !== null ? (
        <s-text color="subdued">{t("results.capped_note", { limit: data.capped })}</s-text>
      ) : null}

      {/* Plain CSS auto-fit: six tiles reflow from one column on a phone to
          three or six across, with no container query to verify. */}
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 11rem), 1fr))" gap="base">
        <Metric label={t("results.total")} help={rangeLabel}>
          <BigNumber>{summary.totalResponses}</BigNumber>
        </Metric>
        <Metric label={t("results.answer_rate")} help={t("results.answer_rate_help")}>
          <BigNumber>{data.answerRate === null ? "—" : percent(data.answerRate)}</BigNumber>
        </Metric>
        <Metric label={t("results.revenue")} help={t("results.revenue_help")}>
          <MoneyList amounts={data.revenue} size="large" tone="success" />
        </Metric>
        <Metric label={t("results.aov")} help={t("results.aov_help")}>
          <MoneyList amounts={data.aov} size="large" />
        </Metric>
        <Metric label={t("results.counted_orders")}>
          <BigNumber>{summary.countedOrders}</BigNumber>
        </Metric>
        <Metric label={t("results.pending")} help={t("results.pending_help")}>
          <BigNumber>{summary.pendingResponses}</BigNumber>
        </Metric>
        {headlineScores.map((score) => (
          <Metric
            key={score.kind}
            label={t(score.kind === "nps" ? "results.score_nps" : "results.score_csat")}
            help={t("results.score_based_on", { count: score.total })}
          >
            <BigNumber>{scoreValueText(score, locale, t)}</BigNumber>
          </Metric>
        ))}
      </s-grid>

      <Panel title={t("results.buyers_title")} description={t("results.buyers_description")}>
        {knownBuyers === 0 ? (
          <s-text color="subdued">{t("results.buyers_none")}</s-text>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("results.buyers_type")}</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">{t("results.total")}</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">{t("results.share")}</s-table-header>
              <s-table-header listSlot="labeled" format="currency">{t("results.revenue")}</s-table-header>
              <s-table-header listSlot="labeled" format="currency">{t("results.aov")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {(
                [
                  ["results.buyers_first", buyers.first],
                  ["results.buyers_returning", buyers.returning],
                ] as const
              ).map(([labelKey, group]) => (
                <s-table-row key={labelKey}>
                  <s-table-cell>{t(labelKey)}</s-table-cell>
                  <s-table-cell>{String(group.responses)}</s-table-cell>
                  <s-table-cell>{percent(Math.round((group.responses / knownBuyers) * 100))}</s-table-cell>
                  <s-table-cell>
                    <MoneyList amounts={group.revenue} />
                  </s-table-cell>
                  <s-table-cell>
                    <MoneyList amounts={group.aov} />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {buyers.unknown > 0 && knownBuyers > 0 ? (
          <s-text color="subdued" fontSize="small">
            {t("results.buyers_unknown", { count: buyers.unknown })}
          </s-text>
        ) : null}
      </Panel>

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
                      <s-text fontVariantNumeric="tabular-nums">
                        {t("results.option_count", { count: option.count, percent: option.percent })}
                      </s-text>
                    </s-grid>
                    <s-progress value={Math.round((option.count / max) * 100)} max={100} />
                    {option.revenue.length > 0 ? (
                      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 9rem), 1fr))" gap="small">
                        <s-stack gap="small-300">
                          <s-text color="subdued" fontSize="small">
                            {t("results.revenue")}
                          </s-text>
                          <MoneyList amounts={option.revenue} />
                        </s-stack>
                        <s-stack gap="small-300">
                          <s-text color="subdued" fontSize="small">
                            {t("results.aov")}
                          </s-text>
                          <MoneyList amounts={option.aov} />
                        </s-stack>
                      </s-grid>
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
