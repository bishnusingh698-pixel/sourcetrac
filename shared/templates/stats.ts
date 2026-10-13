/**
 * Pure aggregation for the Results tab, Overview and Home.
 *
 * Everything here is derived from already-loaded response rows: no database, no
 * network. That keeps it unit-testable against hand-computed numbers and keeps
 * the read paths honest — the confidence meter, the by-product table, the
 * cross-question view and the "ideas to try" rules all read the same shapes.
 *
 * Money is deliberately absent: revenue stays in `survey-analytics.server.ts`,
 * which is the only place that decides whether an answer counts, and which never
 * flattens currencies. These functions deal in counts and shares only.
 */

import { confidenceFor, confidenceForNumeric } from "./confidence";
import type { ConfidenceLevel, IdeaStats } from "./ideas";

export type StatsAnswer = {
  questionId: string;
  optionIds: string[];
  numberValue: number | null;
  textValue: string | null;
  otherText: string | null;
};

export type StatsResponse = {
  /** T8: numeric product ids on the order's lines. */
  productIds: string[];
  answers: StatsAnswer[];
};

export type StatsQuestion = {
  id: string;
  type: string;
  options: ReadonlyArray<{ id: string; label: string; archived: boolean }>;
};

/** The choice/score types whose answers form a distribution. */
const DISTRIBUTION_TYPES = new Set(["single_choice", "multi_choice", "dropdown", "rating_5", "nps", "satisfaction_5"]);

export function isDistributionType(type: string): boolean {
  return DISTRIBUTION_TYPES.has(type);
}

export function isNumericType(type: string): boolean {
  return type === "rating_5" || type === "nps" || type === "satisfaction_5";
}

/** The survey's main question: the first question whose answer forms a distribution. */
export function mainQuestion(questions: ReadonlyArray<StatsQuestion>): StatsQuestion | null {
  return questions.find((q) => isDistributionType(q.type)) ?? null;
}

export type QuestionStats = {
  questionId: string;
  type: string;
  /** Responses that answered this question. */
  n: number;
  /** Choice types: share (0–1) per option id. */
  shares: Record<string, number>;
  topOptionKey: string | null;
  topShare: number;
  /** Numeric types: mean value, or null with no answers. */
  average: number | null;
  /** Numeric NPS: promoter/passive/detractor shares. */
  nps?: { promoter: number; passive: number; detractor: number };
  confidence: ConfidenceLevel;
};

function emptyStats(question: StatsQuestion): QuestionStats {
  return {
    questionId: question.id,
    type: question.type,
    n: 0,
    shares: {},
    topOptionKey: null,
    topShare: 0,
    average: null,
    confidence: "too_early",
  };
}

/** Aggregate one question's answers into counts, shares and a confidence label. */
export function buildQuestionStats(
  responses: ReadonlyArray<StatsResponse>,
  question: StatsQuestion,
): QuestionStats {
  const stats = emptyStats(question);
  const answered = responses.filter((r) => r.answers.some((a) => a.questionId === question.id));
  stats.n = answered.length;

  if (isNumericType(question.type)) {
    let sum = 0;
    let count = 0;
    let promoters = 0;
    let passives = 0;
    let detractors = 0;
    for (const response of answered) {
      const value = response.answers.find((a) => a.questionId === question.id)?.numberValue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      sum += value;
      count += 1;
      if (question.type === "nps") {
        if (value >= 9) promoters += 1;
        else if (value <= 6) detractors += 1;
        else passives += 1;
      }
    }
    stats.average = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
    if (question.type === "nps" && count > 0) {
      stats.nps = { promoter: promoters / count, passive: passives / count, detractor: detractors / count };
    }
    stats.confidence = confidenceForNumeric(stats.n);
    return stats;
  }

  const counts = new Map<string, number>();
  for (const response of answered) {
    const answer = response.answers.find((a) => a.questionId === question.id);
    if (!answer) continue;
    for (const id of answer.optionIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of counts) stats.shares[id] = stats.n > 0 ? count / stats.n : 0;

  let topKey: string | null = null;
  let topCount = 0;
  // Ties break on the option's display order, so the top answer never flickers
  // between renders.
  for (const option of question.options) {
    const count = counts.get(option.id) ?? 0;
    if (count > topCount) {
      topCount = count;
      topKey = option.id;
    }
  }
  stats.topOptionKey = topKey;
  stats.topShare = stats.n > 0 ? topCount / stats.n : 0;
  stats.confidence = confidenceFor(stats.n, stats.topShare);
  return stats;
}

/** option id -> label, from every question's options. */
export function optionLabels(questions: ReadonlyArray<StatsQuestion>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const question of questions) {
    for (const option of question.options) labels[option.id] = option.label;
  }
  return labels;
}

/**
 * Build the `IdeaStats` the rule engine reads (T12).
 *
 * `byProduct` is populated only when a template asks for it (`resultsHints.byProduct`),
 * so a survey that doesn't care about products does no extra work. Products with
 * fewer than `MIN_PRODUCT_RESPONSES` answers are dropped (T8's limit).
 */
export function buildIdeaStats(params: {
  responses: ReadonlyArray<StatsResponse>;
  questions: ReadonlyArray<StatsQuestion>;
  productTitles?: Record<string, string>;
  byProduct?: boolean;
  minProductResponses?: number;
}): IdeaStats {
  const question = mainQuestion(params.questions);
  const labels = optionLabels(params.questions);
  if (!question) {
    return {
      n: 0,
      confidence: "too_early",
      shares: {},
      topOptionKey: null,
      topShare: 0,
      optionLabels: labels,
      average: null,
      byProduct: [],
    };
  }

  const stats = buildQuestionStats(params.responses, question);
  const base: IdeaStats = {
    n: stats.n,
    confidence: stats.confidence,
    shares: { ...stats.shares, ...(stats.nps ?? {}) },
    topOptionKey: stats.topOptionKey,
    topShare: stats.topShare,
    optionLabels: labels,
    average: stats.average,
    byProduct: [],
  };

  if (params.byProduct) {
    const min = params.minProductResponses ?? 10;
    base.byProduct = buildProductBreakdown({
      responses: params.responses,
      question,
      productTitles: params.productTitles ?? {},
      minResponses: min,
    }).map((row) => ({
      productId: row.productId,
      productTitle: row.productTitle,
      n: row.n,
      confidence: row.confidence,
      shares: row.shares,
      topOptionKey: row.topOptionKey,
      topShare: row.topShare,
      optionLabels: labels,
    }));
  }

  return base;
}

export type ProductBreakdownRow = {
  productId: string;
  productTitle: string;
  n: number;
  shares: Record<string, number>;
  topOptionKey: string | null;
  topShare: number;
  confidence: ConfidenceLevel;
};

/**
 * Answers grouped by purchased product (T8).
 *
 * A response can name several products, so it contributes to each one. Products
 * below `minResponses` are dropped, and the list is capped at `maxProducts`
 * (the busiest first) so the table never grows without bound.
 */
export function buildProductBreakdown(params: {
  responses: ReadonlyArray<StatsResponse>;
  question: StatsQuestion;
  productTitles: Record<string, string>;
  minResponses?: number;
  maxProducts?: number;
}): ProductBreakdownRow[] {
  const min = params.minResponses ?? 10;
  const max = params.maxProducts ?? 20;
  const byProduct = new Map<string, StatsResponse[]>();

  for (const response of params.responses) {
    for (const productId of new Set(response.productIds)) {
      const bucket = byProduct.get(productId) ?? [];
      bucket.push(response);
      byProduct.set(productId, bucket);
    }
  }

  return [...byProduct.entries()]
    .map(([productId, responses]) => {
      const stats = buildQuestionStats(responses, params.question);
      return {
        productId,
        productTitle: params.productTitles[productId] ?? productId,
        n: stats.n,
        shares: stats.shares,
        topOptionKey: stats.topOptionKey,
        topShare: stats.topShare,
        confidence: stats.confidence,
      };
    })
    .filter((row) => row.n >= min)
    .sort((a, b) => b.n - a.n)
    .slice(0, max);
}

export type CrossTab = {
  rowQuestionId: string;
  colQuestionId: string;
  /** Option ids in display order. */
  rowKeys: string[];
  colKeys: string[];
  /** rowKey -> colKey -> count. */
  cells: Record<string, Record<string, number>>;
  /** Responses that answered both questions. */
  total: number;
  /** T14: the view needs at least this many shared answers. */
  enough: boolean;
};

export const CROSS_TAB_MIN = 30;

/**
 * Cross-question view (T14): rows = answers to A, columns = answers to B, each
 * cell a percentage of its row.
 *
 * Only responses that answered both questions count, so the rows and columns
 * agree. A multi-choice question contributes its response to each chosen option.
 */
export function buildCrossTab(params: {
  responses: ReadonlyArray<StatsResponse>;
  rowQuestion: StatsQuestion;
  colQuestion: StatsQuestion;
}): CrossTab {
  const rowKeys = params.rowQuestion.options.map((o) => o.id);
  const colKeys = params.colQuestion.options.map((o) => o.id);
  const cells: Record<string, Record<string, number>> = {};
  for (const key of rowKeys) cells[key] = {};
  let total = 0;

  for (const response of params.responses) {
    const rowAnswer = response.answers.find((a) => a.questionId === params.rowQuestion.id);
    const colAnswer = response.answers.find((a) => a.questionId === params.colQuestion.id);
    if (!rowAnswer || !colAnswer) continue;
    if (rowAnswer.optionIds.length === 0 || colAnswer.optionIds.length === 0) continue;
    total += 1;
    for (const rowKey of rowAnswer.optionIds) {
      const row = cells[rowKey];
      if (!row) continue;
      for (const colKey of colAnswer.optionIds) {
        if (!colKeys.includes(colKey)) continue;
        row[colKey] = (row[colKey] ?? 0) + 1;
      }
    }
  }

  return {
    rowQuestionId: params.rowQuestion.id,
    colQuestionId: params.colQuestion.id,
    rowKeys,
    colKeys,
    cells,
    total,
    enough: total >= CROSS_TAB_MIN,
  };
}

/** Row percentages for the cross-tab, relative to the row total (not 100%). */
export function crossTabRowShares(tab: CrossTab, rowKey: string): Record<string, number> {
  const row = tab.cells[rowKey] ?? {};
  const total = tab.colKeys.reduce((sum, colKey) => sum + (row[colKey] ?? 0), 0);
  const shares: Record<string, number> = {};
  for (const colKey of tab.colKeys) {
    shares[colKey] = total > 0 ? (row[colKey] ?? 0) / total : 0;
  }
  return shares;
}
