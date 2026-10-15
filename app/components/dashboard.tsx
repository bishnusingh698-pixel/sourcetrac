import type { TFunction } from "~/lib/i18n";
import type { Dashboard, DashboardSurvey, PooledScore, SurveyHeadline } from "~/lib/dashboard.server";
import type { CsatResult, NpsResult } from "@shared/survey-rules";

import { BigNumber, MoneyList, Panel, type BadgeTone } from "~/components/admin-ui";
import { channelName } from "~/components/channel-report";
import { ConfidenceBadge } from "~/components/insights";
import { ScoreBlock } from "~/components/scores";
import { fixedOptionLabel } from "~/lib/answer-text";

/**
 * The Dashboard's sections. Pure presentation: `loadDashboard` computes and
 * formats every number, and these only lay them out.
 *
 * Each section ends with a link to the page that has the full story (Results,
 * the channel report, Surveys), so the Dashboard summarises without repeating.
 */

/** Where a merchant with no score question can add one: the loyalty templates. */
export const SCORE_TEMPLATES_HREF = "/app/surveys/library?category=loyalty";

/**
 * A link to Results in the same date range, so the numbers there match the row
 * the merchant clicked. Results takes the same day counts as range keys.
 */
function resultsHref(surveyId: string | null, days: number): string {
  const params = new URLSearchParams();
  if (surveyId) params.set("survey", surveyId);
  params.set("range", String(days));
  return `/app/results?${params.toString()}`;
}

/**
 * NPS and CSAT for the whole shop, side by side, then one row per question when
 * there is more than one. A shop that asks neither gets a short explanation and
 * a button to add a survey that does, so the scores are never hard to find.
 */
export function ScoresSection({
  scores,
  t,
  locale,
  rangeLabel,
  days,
}: {
  scores: Dashboard["scores"];
  t: TFunction;
  locale: string;
  rangeLabel: string;
  days: number;
}) {
  // One question per kind is already shown in full by its pooled tile; the
  // list only adds something when a score is made of several questions.
  const showByQuestion = (scores.nps?.questions ?? 0) > 1 || (scores.csat?.questions ?? 0) > 1;

  return (
    <s-section heading={t("home.scores_title")} subheading={t("home.scores_subtitle", { range: rangeLabel })}>
      <s-stack gap="base">
        <s-query-container>
          <s-grid
            gridTemplateColumns="@container (inline-size > 560px) repeat(2, minmax(0, 1fr)), minmax(0, 1fr)"
            gap="base"
          >
            <PooledScoreTile kind="nps" pooled={scores.nps} asks={scores.asks.nps} t={t} locale={locale} days={days} />
            <PooledScoreTile kind="csat" pooled={scores.csat} asks={scores.asks.csat} t={t} locale={locale} days={days} />
          </s-grid>
        </s-query-container>

        {showByQuestion ? (
          <s-stack gap="small">
            <s-text type="strong">{t("home.by_question")}</s-text>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">{t("home.col_question")}</s-table-header>
                <s-table-header listSlot="secondary" format="numeric">
                  {t("home.col_score")}
                </s-table-header>
                <s-table-header listSlot="labeled" format="numeric">
                  {t("dashboard.col_responses")}
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {scores.cards.map((card) => (
                  <s-table-row key={card.questionId}>
                    <s-table-cell>
                      <s-stack gap="small-300">
                        <s-link href={resultsHref(card.surveyId, days)}>{card.surveyName}</s-link>
                        <s-text color="subdued" fontSize="small">
                          {card.questionText}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text type="strong" fontVariantNumeric="tabular-nums">
                        {card.score.kind === "nps"
                          ? t("home.key_nps", { value: signed(card.score.score, locale) })
                          : t("home.key_csat", { value: wholePercent(card.score.percent, locale, t) })}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text fontVariantNumeric="tabular-nums">{String(card.score.total)}</s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}

function PooledScoreTile({
  kind,
  pooled,
  asks,
  t,
  locale,
  days,
}: {
  kind: "nps" | "csat";
  pooled: PooledScore<NpsResult> | PooledScore<CsatResult> | null;
  asks: boolean;
  t: TFunction;
  locale: string;
  days: number;
}) {
  if (pooled) {
    const score =
      kind === "nps"
        ? { kind: "nps" as const, ...(pooled.result as NpsResult) }
        : { kind: "csat" as const, ...(pooled.result as CsatResult) };
    return (
      <s-stack gap="small">
        <ScoreBlock score={score} locale={locale} t={t} />
        <s-stack direction="inline" gap="small" alignItems="center">
          {pooled.questions > 1 ? (
            <s-text color="subdued" fontSize="small">
              {t("home.score_pooled", { count: pooled.questions })}
            </s-text>
          ) : null}
          <s-link href={resultsHref(pooled.surveyId, days)}>{t("home.see_answers")}</s-link>
        </s-stack>
      </s-stack>
    );
  }

  // No score yet. Either the question exists and nobody answered it in this
  // range, or no survey asks it: only the second gets the "add a survey" nudge.
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small">
        <s-text type="strong">{t(kind === "nps" ? "results.score_nps" : "results.score_csat")}</s-text>
        <BigNumber>—</BigNumber>
        <s-text color="subdued">
          {asks ? t("home.score_no_answers") : t(kind === "nps" ? "home.nps_none_body" : "home.csat_none_body")}
        </s-text>
        {asks ? null : (
          <div>
            <s-button href={SCORE_TEMPLATES_HREF} icon="plus">
              {t("home.add_score_survey")}
            </s-button>
          </div>
        )}
      </s-stack>
    </s-box>
  );
}

function signed(value: number, locale: string): string {
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  return value > 0 ? `+${text}` : text;
}

function wholePercent(value: number, locale: string, t: TFunction): string {
  return t("results.score_share_percent", {
    percent: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value),
  });
}

/**
 * The five busiest channels, as labelled bars. The full table, with average
 * order values, pending answers and written-in answers, is the channel report.
 */
export function TopChannels({
  report,
  t,
  locale,
  rangeLabel,
  reportHref,
}: {
  report: Dashboard["report"];
  t: TFunction;
  locale: string;
  rangeLabel: string;
  reportHref: string;
}) {
  const rows = report.channels.slice(0, 5);
  const total = report.channels.reduce((sum, channel) => sum + channel.responses, 0);
  const busiest = Math.max(1, ...report.channels.map((channel) => channel.responses));
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  return (
    <Panel title={t("home.top_channels_title")} description={t("home.top_channels_subtitle", { range: rangeLabel })}>
      {rows.length === 0 ? (
        <s-text color="subdued">{t("home.top_channels_empty")}</s-text>
      ) : (
        <s-stack gap="base">
          {rows.map((channel, index) => {
            const name = channelName(channel.label, t);
            // Bars are relative to the busiest channel, so a flat spread reads
            // as comparable bars; the label carries the share of all answers.
            const ofTotal = total > 0 ? Math.round((channel.responses / total) * 100) : 0;
            const bar = Math.round((channel.responses / busiest) * 100);
            return (
              <s-stack key={channel.channel} gap="small-200">
                <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-text type="strong">{name}</s-text>
                    {index === 0 ? <s-badge tone="success">{t("dashboard.top_channel")}</s-badge> : null}
                  </s-stack>
                  <s-text fontVariantNumeric="tabular-nums">
                    {t("results.option_count", { count: channel.responses, percent: percent.format(ofTotal) })}
                  </s-text>
                </s-grid>
                <s-progress
                  value={bar}
                  max={100}
                  tone={index === 0 ? "success" : "info"}
                  accessibilityLabel={t("dashboard.share_aria", { channel: name, share: bar })}
                />
                {channel.revenue.length > 0 ? (
                  <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="center">
                    <s-text color="subdued" fontSize="small">
                      {t("dashboard.col_revenue")}
                    </s-text>
                    <MoneyList amounts={channel.revenue} />
                  </s-grid>
                ) : null}
              </s-stack>
            );
          })}
          <div>
            <s-button href={reportHref} icon="channels">
              {t("home.open_report")}
            </s-button>
          </div>
        </s-stack>
      )}
    </Panel>
  );
}

/** First-order vs returning buyers, one row per group, each order counted once. */
export function BuyerMix({ buyers, t, locale }: { buyers: Dashboard["buyers"]; t: TFunction; locale: string }) {
  const known = buyers.first.orders + buyers.returning.orders;
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  return (
    <Panel title={t("results.buyers_title")} description={t("home.buyers_subtitle")}>
      {known === 0 ? (
        <s-text color="subdued">{t("results.buyers_none")}</s-text>
      ) : (
        <s-stack gap="small">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("results.buyers_type")}</s-table-header>
              <s-table-header listSlot="secondary" format="numeric">
                {t("home.col_orders")}
              </s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                {t("results.share")}
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                {t("results.revenue")}
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                {t("results.aov")}
              </s-table-header>
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
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">{String(group.orders)}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">
                      {t("results.cross_percent", { percent: percent.format(group.share) })}
                    </s-text>
                  </s-table-cell>
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
          {buyers.unknown > 0 ? (
            <s-text color="subdued" fontSize="small">
              {t("home.buyers_unknown", { count: buyers.unknown })}
            </s-text>
          ) : null}
        </s-stack>
      )}
    </Panel>
  );
}

const STATUS_TONE: Record<string, BadgeTone> = { active: "success", paused: "warning" };

/** A survey's key result in words: `NPS +32`, `CSAT 86%`, `Instagram · 34%`. */
export function headlineText(headline: SurveyHeadline | null, t: TFunction): string {
  if (!headline) return "—";
  switch (headline.kind) {
    case "nps":
      return t("home.key_nps", { value: headline.value });
    case "csat":
      return t("home.key_csat", { value: headline.value });
    case "average":
      return t("home.key_average", { value: headline.value });
    case "top":
      return t("home.key_top", {
        label: headline.label ?? fixedOptionLabel(headline.optionId, t) ?? headline.optionId,
        share: headline.share,
      });
  }
}

/** Every live survey (and any other that collected answers in the range). */
export function SurveysOverview({
  surveys,
  surveyCount,
  t,
  locale,
  rangeLabel,
  days,
}: {
  surveys: DashboardSurvey[];
  surveyCount: number;
  t: TFunction;
  locale: string;
  rangeLabel: string;
  days: number;
}) {
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  return (
    <Panel title={t("home.your_surveys")} description={t("home.surveys_subtitle", { range: rangeLabel })}>
      {surveys.length === 0 ? (
        <s-stack gap="base">
          <s-text color="subdued">{t("surveys.empty_body")}</s-text>
          <div>
            <s-button href="/app/surveys/library" variant="primary" icon="plus">
              {t("surveys.use_template")}
            </s-button>
          </div>
        </s-stack>
      ) : (
        <s-stack gap="small">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("results.compare_survey")}</s-table-header>
              <s-table-header listSlot="secondary">{t("home.col_key_result")}</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                {t("dashboard.col_responses")}
              </s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                {t("results.answer_rate")}
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                {t("results.revenue")}
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {surveys.map((survey) => (
                <s-table-row key={survey.id}>
                  <s-table-cell>
                    <s-stack gap="small-200">
                      <s-link href={resultsHref(survey.id, days)}>{survey.name}</s-link>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge tone={STATUS_TONE[survey.status] ?? "neutral"}>{t(`surveys.status_${survey.status}`)}</s-badge>
                        {survey.answers > 0 ? (
                          <ConfidenceBadge level={survey.confidence} n={survey.confidenceN} t={t} />
                        ) : null}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text type="strong">{headlineText(survey.headline, t)}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">{String(survey.answers)}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">
                      {survey.answerRate === null
                        ? "—"
                        : t("results.cross_percent", { percent: percent.format(survey.answerRate) })}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <MoneyList amounts={survey.revenue} />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-stack direction="inline" gap="base">
            <s-link href={resultsHref(null, days)}>{t("home.compare_surveys")}</s-link>
            {surveyCount > surveys.length ? <s-link href="/app/surveys">{t("home.view_all")}</s-link> : null}
          </s-stack>
        </s-stack>
      )}
    </Panel>
  );
}
