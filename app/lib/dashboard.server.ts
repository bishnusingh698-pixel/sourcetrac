/**
 * The Dashboard (the app's home page): every important number on one screen.
 *
 * It is deliberately a summary of the other pages, never a copy of one:
 *
 * - The money and answer numbers come from `loadChannelReport`, the same loader
 *   the channel report uses, so the two pages can never disagree.
 * - NPS and CSAT are pooled across every survey's score questions in the range,
 *   and listed per question, so a merchant sees them without opening Results.
 * - New vs returning buyers is across every survey, one row per order.
 * - Each survey gets one row with its key result; Results has everything else.
 *
 * Every figure is formatted here on the server. The browser never sees
 * minor-unit integers, and no money is added across currencies.
 */

import { db } from "~/db.server";
import { windowBounds } from "~/lib/analytics";
import type { DashboardRange } from "~/lib/dashboard-range";
import { loadChannelReport, type ChannelReport } from "~/lib/channel-report.server";
import { buildSurveyInsights } from "~/lib/insights.server";
import { formatMoney } from "~/lib/money";
import {
  aovMinor,
  answerRatePercent,
  fetchSurveyResponses,
  questionScore,
  summariseSurvey,
  surveyAnswerRates,
  type CurrencyTotal,
  type QuestionScore,
  type SurveyAnswerRow,
  type SurveyResponseRow,
  type SurveySummary,
} from "~/lib/survey-analytics.server";
import { listSurveys, type SurveyListItem } from "~/lib/surveys.server";
import {
  csatResult,
  npsResult,
  satisfactionValue,
  type CountBucket,
  type CsatResult,
  type NpsResult,
} from "@shared/survey-rules";

/**
 * The newest answers the dashboard reads in one range. A shop at the top of the
 * target size (2,000 orders a month) stays well inside it even over 90 days;
 * above it the page says the scores are based on the newest answers.
 */
export const DASHBOARD_RESPONSE_LIMIT = 10_000;

/** Surveys listed on the dashboard; the Surveys page lists them all. */
const SURVEY_ROW_LIMIT = 6;
/** Score questions shown one by one; the pooled tile covers all of them. */
const SCORE_CARD_LIMIT = 4;

const SCORE_TYPES = new Set(["nps", "rating_5", "satisfaction_5"]);

/**
 * The value a score question's answer contributes: 0–10 for NPS, 1–5 for a
 * rating or satisfaction question. Satisfaction is chosen as a level id; older
 * answers stored only that id, so the value is derived from it when
 * `numberValue` is empty (the same rule the Results stats use).
 */
export function scoreAnswerValue(type: string, answer: Pick<SurveyAnswerRow, "numberValue" | "optionIds">): number | null {
  if (typeof answer.numberValue === "number" && Number.isFinite(answer.numberValue)) return answer.numberValue;
  if (type === "satisfaction_5" && answer.optionIds.length === 1) {
    return satisfactionValue(answer.optionIds[0] as string) ?? null;
  }
  return null;
}

export type ScoreCard = {
  surveyId: string;
  surveyName: string;
  questionId: string;
  questionText: string;
  score: QuestionScore;
};

export type PooledScore<T> = {
  result: T;
  /** How many questions the pooled score is made of. */
  questions: number;
  /** The one survey behind it, so its tile can link there; null for several. */
  surveyId: string | null;
};

export type ScoreSummary = {
  /** Every NPS answer in the range, across all surveys. Null with none. */
  nps: PooledScore<NpsResult> | null;
  /** Every 1–5 rating and satisfaction answer in the range. Null with none. */
  csat: PooledScore<CsatResult> | null;
  /** One card per score question with answers, most answered first. */
  cards: ScoreCard[];
  /** Whether any survey asks an NPS / CSAT question at all, answered or not. */
  asks: { nps: boolean; csat: boolean };
};

/**
 * NPS and CSAT for the whole shop, plus one card per question.
 *
 * Pure: it reads already-loaded responses and the survey definitions. Pooling
 * is the plain definition applied to every answer (promoters minus detractors
 * over all NPS answers), so the shop's NPS is not an average of averages. An
 * answer counts only for a question its own survey asks, so a question id from
 * another survey can never leak into a score.
 */
export function buildScoreSummary(params: {
  responses: ReadonlyArray<Pick<SurveyResponseRow, "surveyId" | "answers">>;
  surveys: ReadonlyArray<{
    id: string;
    name: string;
    questions: ReadonlyArray<{ id: string; type: string; text: string }>;
  }>;
}): ScoreSummary {
  const questions = new Map<string, { surveyId: string; surveyName: string; type: string; text: string; order: number }>();
  let order = 0;
  for (const survey of params.surveys) {
    for (const question of survey.questions) {
      if (!SCORE_TYPES.has(question.type)) continue;
      questions.set(question.id, {
        surveyId: survey.id,
        surveyName: survey.name,
        type: question.type,
        text: question.text,
        order: order++,
      });
    }
  }

  const buckets = new Map<string, Map<number, number>>();
  for (const response of params.responses) {
    for (const answer of response.answers) {
      const question = questions.get(answer.questionId);
      if (!question || question.surveyId !== response.surveyId) continue;
      const value = scoreAnswerValue(question.type, answer);
      if (value === null) continue;
      const counts = buckets.get(answer.questionId) ?? new Map<number, number>();
      counts.set(value, (counts.get(value) ?? 0) + 1);
      buckets.set(answer.questionId, counts);
    }
  }

  const toBuckets = (counts: Map<number, number> | undefined): CountBucket[] =>
    [...(counts ?? new Map<number, number>()).entries()].map(([value, count]) => ({ value, count }));

  const cards: Array<ScoreCard & { order: number }> = [];
  const npsPool: CountBucket[] = [];
  const csatPool: CountBucket[] = [];
  const npsSurveys = new Set<string>();
  const csatSurveys = new Set<string>();
  let npsQuestions = 0;
  let csatQuestions = 0;

  for (const [questionId, question] of questions) {
    const list = toBuckets(buckets.get(questionId));
    const score = questionScore(question.type, list);
    if (!score) continue;
    cards.push({
      surveyId: question.surveyId,
      surveyName: question.surveyName,
      questionId,
      questionText: question.text,
      score,
      order: question.order,
    });
    if (score.kind === "nps") {
      npsPool.push(...list);
      npsSurveys.add(question.surveyId);
      npsQuestions += 1;
    } else {
      csatPool.push(...list);
      csatSurveys.add(question.surveyId);
      csatQuestions += 1;
    }
  }

  const nps = npsResult(npsPool);
  const csat = csatResult(csatPool);
  const types = [...questions.values()].map((q) => q.type);

  return {
    nps: nps ? { result: nps, questions: npsQuestions, surveyId: onlyOne(npsSurveys) } : null,
    csat: csat ? { result: csat, questions: csatQuestions, surveyId: onlyOne(csatSurveys) } : null,
    cards: cards
      .sort((a, b) => b.score.total - a.score.total || a.order - b.order)
      .slice(0, SCORE_CARD_LIMIT)
      .map(({ order: _order, ...card }) => card),
    asks: {
      nps: types.includes("nps"),
      csat: types.includes("rating_5") || types.includes("satisfaction_5"),
    },
  };
}

function onlyOne(ids: Set<string>): string | null {
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

/**
 * First-time vs returning buyers across every survey, counting each ORDER once.
 *
 * Answers with no order (on-site, link) have no buyer history and no revenue,
 * so they are left out rather than piling up as "unknown".
 *
 * `submitAnswers` already stores one answer set per order across all surveys,
 * so an order normally appears once. The de-duplication is kept anyway: this
 * figure sums revenue across surveys, and a second row for an order (from data
 * written before that rule, or a future path that skips it) must not double
 * the buyer and their order's revenue. The row kept is the one that knows the
 * most: one that says whether it was a first order, then one whose order total
 * has arrived.
 */
export function buyerMix(responses: ReadonlyArray<SurveyResponseRow>): SurveySummary["buyers"] {
  const rank = (row: SurveyResponseRow) => (row.isFirstOrder !== null ? 2 : 0) + (row.orderTotal !== null ? 1 : 0);
  const byOrder = new Map<string, SurveyResponseRow>();
  for (const response of responses) {
    if (response.orderId === null) continue;
    const kept = byOrder.get(response.orderId);
    if (!kept || rank(response) > rank(kept)) byOrder.set(response.orderId, response);
  }
  return summariseSurvey([...byOrder.values()]).buyers;
}

/** A survey's key result, for its row on the dashboard. */
export type SurveyHeadline =
  | { kind: "nps"; value: string }
  | { kind: "csat"; value: string }
  | { kind: "average"; value: string }
  /** `label` is the merchant's option label; null for a fixed option (Yes/No). */
  | { kind: "top"; optionId: string; label: string | null; share: string };

export type DashboardSurvey = {
  id: string;
  name: string;
  status: SurveyListItem["status"];
  answers: number;
  /** Whole percent of orders since the survey started; null with no orders. */
  answerRate: number | null;
  revenue: Money[];
  headline: SurveyHeadline | null;
  confidence: string;
  /** The answers the confidence label is computed from. */
  confidenceN: number;
  hasDraft: boolean;
};

type Money = { currency: string; text: string };

type DashboardShop = Parameters<typeof loadChannelReport>[0]["shop"];

/**
 * Pick the surveys worth a row: every live one, then any other that collected
 * answers in the range (a survey paused last week still has this month's
 * results). Busiest first, then the merchant's own priority order.
 */
export function pickDashboardSurveys<T extends { id: string; status: string }>(
  surveys: ReadonlyArray<T>,
  answersBySurvey: ReadonlyMap<string, number>,
  limit = SURVEY_ROW_LIMIT,
): T[] {
  return surveys
    .map((survey, index) => ({ survey, index, answers: answersBySurvey.get(survey.id) ?? 0 }))
    .filter(({ survey, answers }) => survey.status === "active" || answers > 0)
    .sort((a, b) => b.answers - a.answers || a.index - b.index)
    .slice(0, limit)
    .map(({ survey }) => survey);
}

export async function loadDashboard(params: {
  shop: DashboardShop;
  days: DashboardRange;
  locale: string;
  now?: Date;
}) {
  const { shop, days, locale } = params;
  // One clock for every query, so no section can straddle midnight.
  const now = params.now ?? new Date();
  const { start, end } = windowBounds(days, now);

  const [report, surveys, fetched, questionRows, drafts] = await Promise.all([
    loadChannelReport({ shop, days, locale, now }),
    listSurveys(shop.id),
    fetchSurveyResponses({ shopId: shop.id, start, end, limit: DASHBOARD_RESPONSE_LIMIT + 1 }),
    db.question.findMany({
      where: { survey: { shopId: shop.id } },
      orderBy: { position: "asc" },
      select: {
        id: true,
        surveyId: true,
        type: true,
        text: true,
        templateKey: true,
        archived: true,
        options: { orderBy: { position: "asc" }, select: { id: true, label: true, archived: true } },
      },
    }),
    db.survey.findMany({ where: { shopId: shop.id, draft: { not: null } }, select: { id: true } }),
  ]);

  const capped = fetched.length > DASHBOARD_RESPONSE_LIMIT;
  const responses = capped ? fetched.slice(0, DASHBOARD_RESPONSE_LIMIT) : fetched;

  const questionsBySurvey = new Map<string, typeof questionRows>();
  for (const question of questionRows) {
    const list = questionsBySurvey.get(question.surveyId) ?? [];
    list.push(question);
    questionsBySurvey.set(question.surveyId, list);
  }
  const responsesBySurvey = new Map<string, SurveyResponseRow[]>();
  for (const response of responses) {
    const list = responsesBySurvey.get(response.surveyId) ?? [];
    list.push(response);
    responsesBySurvey.set(response.surveyId, list);
  }

  const scores = buildScoreSummary({
    responses,
    surveys: surveys.map((survey) => ({
      id: survey.id,
      name: survey.name,
      questions: questionsBySurvey.get(survey.id) ?? [],
    })),
  });

  const amount = (minor: number, currency: string) => formatMoney(minor, currency, locale);
  const money = (totals: ReadonlyArray<CurrencyTotal>): Money[] =>
    totals.map((entry) => ({ currency: entry.currency, text: amount(entry.minor, entry.currency) }));
  const aov = (totals: ReadonlyArray<CurrencyTotal>): Money[] =>
    totals.flatMap((entry) => {
      const value = aovMinor(entry);
      return value === null ? [] : [{ currency: entry.currency, text: amount(value, entry.currency) }];
    });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const signed = (value: number) => (value > 0 ? `+${number.format(value)}` : number.format(value));

  const answersBySurvey = new Map([...responsesBySurvey.entries()].map(([id, list]) => [id, list.length] as const));
  const shown = pickDashboardSurveys(surveys, answersBySurvey);
  const rates = await surveyAnswerRates({
    shopId: shop.id,
    surveys: shown.map((survey) => ({ id: survey.id, createdAt: new Date(survey.createdAt) })),
    start,
    end,
  });
  const draftIds = new Set(drafts.map((row) => row.id));

  const surveyRows: DashboardSurvey[] = shown.map((survey) => {
    const rows = responsesBySurvey.get(survey.id) ?? [];
    const questions = questionsBySurvey.get(survey.id) ?? [];
    const insights = buildSurveyInsights({
      responses: rows,
      questions: questions.map((q) => ({ ...q, options: q.options })),
      templateId: null,
      locale,
    });
    const main = insights.main;
    // A score question says the most about how a survey is going, so it wins
    // over the first question's top answer.
    const card = surveyScoreCard(survey.id, rows, questions);
    let headline: SurveyHeadline | null = null;
    if (card?.score.kind === "nps") headline = { kind: "nps", value: signed(card.score.score) };
    else if (card?.score.kind === "csat") headline = { kind: "csat", value: percent.format(card.score.percent / 100) };
    else if (main?.topOptionKey) {
      const merchantOption = questions.find((q) => q.id === main.questionId)?.options.find((o) => o.id === main.topOptionKey);
      headline = {
        kind: "top",
        optionId: main.topOptionKey,
        label: merchantOption?.label ?? null,
        share: percent.format(main.topShare),
      };
    } else if (main && main.average !== null) headline = { kind: "average", value: number.format(main.average) };

    return {
      id: survey.id,
      name: survey.name,
      status: survey.status,
      answers: rows.length,
      answerRate: answerRatePercent(rates.get(survey.id)),
      revenue: money(summariseSurvey(rows).revenueByCurrency),
      headline,
      confidence: main?.confidence ?? "too_early",
      confidenceN: main?.n ?? 0,
      hasDraft: draftIds.has(survey.id),
    };
  });

  const buyers = buyerMix(responses);
  const knownBuyers = buyers.first.responses + buyers.returning.responses;
  const buyerGroup = (group: SurveySummary["buyers"]["first"]) => ({
    orders: group.responses,
    share: knownBuyers > 0 ? Math.round((group.responses / knownBuyers) * 100) : 0,
    revenue: money(group.revenueByCurrency),
    aov: aov(group.revenueByCurrency),
  });

  return {
    days,
    report,
    scores,
    buyers: {
      first: buyerGroup(buyers.first),
      returning: buyerGroup(buyers.returning),
      unknown: buyers.unknown,
    },
    surveys: surveyRows,
    /** Surveys the shop has in total, for "View all". */
    surveyCount: surveys.length,
    /** The answer limit when the scores and buyers read only the newest answers. */
    cappedAt: capped ? DASHBOARD_RESPONSE_LIMIT : null,
  };
}

/** A survey's most-answered score question, if it has one with answers. */
function surveyScoreCard(
  surveyId: string,
  responses: ReadonlyArray<SurveyResponseRow>,
  questions: ReadonlyArray<{ id: string; type: string; text: string }>,
): ScoreCard | null {
  const summary = buildScoreSummary({ responses, surveys: [{ id: surveyId, name: "", questions }] });
  return summary.cards[0] ?? null;
}

export type Dashboard = Awaited<ReturnType<typeof loadDashboard>>;
export type { ChannelReport };
