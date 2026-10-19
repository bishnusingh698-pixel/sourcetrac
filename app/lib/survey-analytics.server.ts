/**
 * Read-side analytics for the multi-question model.
 *
 * Mirrors `analytics-queries.server.ts` but works on `Response` / `Answer`
 * rather than the single `SurveyResponse.channel`. The revenue policy is the
 * same one: `revenue.ts` decides, and no caller may flatten currencies. A
 * response is "pending" when its order total is not yet known — never $0.00.
 *
 * Kept separate from the old module so the dashboard's channel report keeps
 * reading the old tables untouched.
 */

import { db, isRetryableDbError } from "~/db.server";
import { previousWindowBounds, windowBounds } from "~/lib/analytics";
import type { RevenueStatus } from "~/lib/csv";
import { formatDecimalForCurrency } from "~/lib/money";
import { evaluateResponseRevenue, type RevenueDecision } from "~/lib/revenue";
import { withRetry } from "~/lib/retry.server";
import { couldSeeSurveySql } from "~/lib/order-sources";
import {
  SATISFACTION_OPTIONS,
  YES_NO_IDS,
  csatResult,
  npsResult,
  satisfactionValue,
  type CountBucket,
  type CsatResult,
  type NpsResult,
} from "@shared/survey-rules";

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

export type OrderFacts = {
  currency: string;
  totalPrice: string | null;
  financialStatus: string | null;
  isTest: boolean;
  isCancelled: boolean;
};

export type SurveyAnswerRow = {
  questionId: string;
  optionIds: string[];
  numberValue: number | null;
  textValue: string | null;
  otherText: string | null;
};

export type SurveyResponseRow = {
  id: string;
  surveyId: string;
  orderId: string | null;
  orderNumber: string | null;
  orderTotal: string | null;
  currency: string | null;
  placement: string;
  flagged: boolean;
  /** null predates verification; true/false is the snapshot at insert/reconcile. */
  verified: boolean | null;
  /** The order never arrived in time, so the row is excluded from revenue. */
  unverifiedFailed: boolean;
  createdAt: Date;
  /** The buyer's first order with the shop; null when the checkout did not say. */
  isFirstOrder: boolean | null;
  /** T8: numeric product ids on the order's lines (may be empty). */
  productIds: string[];
  answers: SurveyAnswerRow[];
  order: OrderFacts | null;
};

const ORDER_LOOKUP_CHUNK = 2_000;

/**
 * How many of a survey's newest answers the Results page aggregates. Loading
 * every answer and its rows held them all in memory on a 512 MB instance.
 */
export const RESULTS_RESPONSE_LIMIT = 5_000;

/** Load responses for a survey in a window, with their answers and order facts. */
export async function fetchSurveyResponses(params: {
  shopId: string;
  /** Omitted: every survey of the shop. */
  surveyId?: string;
  start?: Date;
  end?: Date;
  limit?: number;
  offset?: number;
}): Promise<SurveyResponseRow[]> {
  const rows = await retryDb(() =>
    db.response.findMany({
      where: {
        shopId: params.shopId,
        ...(params.surveyId ? { surveyId: params.surveyId } : {}),
        ...(params.start || params.end
          ? { createdAt: { ...(params.start ? { gte: params.start } : {}), ...(params.end ? { lt: params.end } : {}) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      ...(params.offset ? { skip: params.offset } : {}),
      ...(params.limit ? { take: params.limit } : {}),
      include: { answers: true },
    }),
  );

  // Join orders on (shopId, orderId). No Prisma relation exists on purpose: a
  // response can precede its order, and requiring a relation would drop it.
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => id !== null))];
  // Chunked so a large export never sends one unbounded `IN (...)` list.
  const orders = [];
  for (let i = 0; i < orderIds.length; i += ORDER_LOOKUP_CHUNK) {
    const chunk = orderIds.slice(i, i + ORDER_LOOKUP_CHUNK);
    orders.push(
      ...(await retryDb(() =>
        db.orderCache.findMany({
          where: { shopId: params.shopId, orderId: { in: chunk } },
          select: {
            orderId: true,
            orderNumber: true,
            currency: true,
            totalPrice: true,
            financialStatus: true,
            isTest: true,
            isCancelled: true,
          },
        }),
      )),
    );
  }
  const orderById = new Map(orders.map((o) => [o.orderId, o]));

  return rows.map((row) => {
    const order = row.orderId ? orderById.get(row.orderId) : undefined;
    return {
      id: row.id,
      surveyId: row.surveyId,
      orderId: row.orderId,
      orderNumber: order?.orderNumber ?? null,
      orderTotal: row.orderTotal === null ? null : row.orderTotal.toString(),
      currency: row.currency,
      placement: row.placement,
      flagged: row.flagged,
      verified: row.verified,
      unverifiedFailed: row.unverifiedFailed,
      createdAt: row.createdAt,
      isFirstOrder: row.isFirstOrder,
      productIds: safeParseArray(row.productIds),
      answers: row.answers.map((answer) => ({
        questionId: answer.questionId,
        optionIds: safeParseArray(answer.optionIds),
        numberValue: answer.numberValue,
        textValue: answer.textValue,
        otherText: answer.otherText,
      })),
      order: order
        ? {
            currency: order.currency,
            totalPrice: order.totalPrice === null ? null : order.totalPrice.toString(),
            financialStatus: order.financialStatus,
            isTest: order.isTest,
            isCancelled: order.isCancelled,
          }
        : null,
    };
  });
}

function safeParseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * THE revenue decision for a multi-question response. Reconciled means the
 * order total is known; an unreconciled response is pending, never $0.00.
 *
 * Verification: a row marked `unverifiedFailed` (the order never arrived and the
 * reconcile sweep gave up) is excluded from revenue, and `verified === false`
 * (a known test/cancelled order, or an order confirmed absent) also excludes it.
 * `verified === null` predates the column and keeps the legacy behaviour — the
 * order total's presence alone decides — so historic revenue is unchanged.
 */
export function decideSurveyRevenue(row: SurveyResponseRow): RevenueDecision {
  if (row.unverifiedFailed) {
    return { included: false, reason: "unreconciled" };
  }
  return evaluateResponseRevenue(
    { reconciled: row.orderTotal !== null, unreconcilable: false },
    row.order
      ? {
          currency: row.order.currency,
          totalPrice: row.order.totalPrice,
          financialStatus: row.order.financialStatus,
          isTest: row.order.isTest,
          isCancelled: row.order.isCancelled,
        }
      : row.currency
        ? {
            currency: row.currency,
            totalPrice: row.orderTotal,
            financialStatus: null,
            isTest: false,
            isCancelled: false,
          }
        : null,
  );
}

/**
 * Why a response does or does not count, in the CSV's words. Shared by the
 * Results CSV and the Responses page so they cannot disagree.
 */
export function surveyRevenueStatus(row: SurveyResponseRow, decision = decideSurveyRevenue(row)): RevenueStatus {
  if (decision.included) return "counted";
  switch (decision.reason) {
    case "test_order":
      return "test order";
    case "cancelled":
      return "cancelled";
    case "voided":
      return "voided";
    case "fully_refunded":
      return "refunded";
    case "unparseable_total":
      return "total unreadable";
    case "unreconciled":
      if (row.orderId === null) return "no order";
      if (row.unverifiedFailed) return "order not received";
      if (row.order && row.order.totalPrice === null) return "total unreadable";
      return "awaiting order";
  }
}

/**
 * The order's total as it stands now, at its currency's precision. The live
 * order (net of refunds and edits) wins over the total snapshotted on the
 * response at first reconcile, so a refunded order does not keep showing its
 * original value next to a revenue figure that already reflects the refund.
 */
export function currentOrderTotal(row: SurveyResponseRow): { total: string; currency: string } | null {
  if (row.order && row.order.totalPrice !== null) {
    const total = formatDecimalForCurrency(row.order.totalPrice, row.order.currency);
    if (total !== null) return { total, currency: row.order.currency };
  }
  if (row.orderTotal !== null && row.currency) {
    const total = formatDecimalForCurrency(row.orderTotal, row.currency);
    if (total !== null) return { total, currency: row.currency };
  }
  return null;
}

/** The headline score a question type has, if any. */
export type QuestionScore = ({ kind: "nps" } & NpsResult) | ({ kind: "csat" } & CsatResult);

export type QuestionBreakdown =
  | {
      kind: "choice";
      questionId: string;
      total: number;
      options: Array<{
        optionId: string;
        count: number;
        /**
         * Net revenue attributed to answers that chose this option, per
         * currency, with the number of counted orders behind it (for AOV).
         */
        revenueByCurrency: CurrencyTotal[];
      }>;
      otherCount: number;
      /** Satisfaction questions: the CSAT score. */
      score: QuestionScore | null;
      /**
       * Multiple choice: an answer with several choices credits its whole order
       * to each one, so the per-option revenue can sum to more than the total.
       * The page says so.
       */
      multiple: boolean;
    }
  | {
      kind: "numeric";
      questionId: string;
      total: number;
      distribution: Array<{ value: number; count: number }>;
      /** NPS for an NPS question, CSAT for a 1–5 rating. */
      score: QuestionScore | null;
    }
  | {
      kind: "text";
      questionId: string;
      total: number;
      /** Newest first, capped for display. */
      answers: Array<{ text: string; otherText: string | null; createdAt: Date; orderId: string | null }>;
    };

/**
 * One breakdown per question, from already-decided revenue. Choice questions
 * carry per-option revenue so the merchant sees which channel earns; numeric
 * questions carry a distribution for NPS/average; text questions list answers.
 */
export function buildBreakdowns(params: {
  responses: ReadonlyArray<SurveyResponseRow>;
  questions: Array<{ id: string; type: string; options: Array<{ id: string; archived: boolean }> }>;
  textLimit?: number;
}): QuestionBreakdown[] {
  const { responses, questions } = params;
  const textLimit = params.textLimit ?? 200;

  return questions.map((question) => {
    const relevant = responses.filter((response) =>
      response.answers.some((answer) => answer.questionId === question.id),
    );

    if (question.type === "text") {
      const answers = responses.flatMap((response) => {
        const answer = response.answers.find((a) => a.questionId === question.id);
        const text = answer?.textValue?.trim() ?? "";
        if (!text && !answer?.otherText) return [];
        return [{ text, otherText: answer?.otherText ?? null, createdAt: response.createdAt, orderId: response.orderId }];
      });
      answers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { kind: "text", questionId: question.id, total: answers.length, answers: answers.slice(0, textLimit) };
    }

    if (question.type === "rating_5" || question.type === "nps") {
      const counts = new Map<number, number>();
      for (const response of responses) {
        const answer = response.answers.find((a) => a.questionId === question.id);
        const value = answer?.numberValue;
        if (typeof value === "number") counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const distribution = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);
      return {
        kind: "numeric",
        questionId: question.id,
        total: distribution.reduce((sum, d) => sum + d.count, 0),
        distribution,
        score: questionScore(question.type, distribution),
      };
    }

    // Choice types (single / multi / dropdown / yes_no / satisfaction). Yes/No
    // and satisfaction have fixed option ids and no Option rows, so their bars
    // come from the fixed list.
    const optionList =
      question.type === "yes_no"
        ? [{ id: YES_NO_IDS.yes }, { id: YES_NO_IDS.no }]
        : question.type === "satisfaction_5"
          ? SATISFACTION_OPTIONS.map((option) => ({ id: option.id }))
          : question.options;
    const optionCounts = new Map<string, number>();
    const revenueByOption = new Map<string, Array<{ currency: string; minor: number }>>();
    let otherCount = 0;

    for (const response of responses) {
      const answer = response.answers.find((a) => a.questionId === question.id);
      if (!answer) continue;

      const decision = decideSurveyRevenue(response);
      const revenue = decision.included && response.order ? { currency: response.order.currency, minor: decision.minor } : null;

      for (const optionId of choiceIds(question.type, answer)) {
        optionCounts.set(optionId, (optionCounts.get(optionId) ?? 0) + 1);
        if (revenue) {
          const bucket = revenueByOption.get(optionId) ?? [];
          bucket.push(revenue);
          revenueByOption.set(optionId, bucket);
        }
      }
      if (answer.otherText) otherCount += 1;
    }

    const options = optionList.map((option) => ({
      optionId: option.id,
      count: optionCounts.get(option.id) ?? 0,
      revenueByCurrency: rollup(revenueByOption.get(option.id) ?? []),
    }));

    return {
      kind: "choice",
      questionId: question.id,
      total: relevant.length,
      options,
      otherCount,
      score:
        question.type === "satisfaction_5"
          ? questionScore(
              question.type,
              options.flatMap((option) => {
                const value = satisfactionValue(option.optionId);
                return value === undefined ? [] : [{ value, count: option.count }];
              }),
            )
          : null,
      multiple: question.type === "multi_choice",
    };
  });
}

/** NPS for an NPS question; CSAT for a 1–5 rating or satisfaction question. */
export function questionScore(type: string, buckets: ReadonlyArray<CountBucket>): QuestionScore | null {
  if (type === "nps") {
    const result = npsResult(buckets);
    return result ? { kind: "nps", ...result } : null;
  }
  if (type === "rating_5" || type === "satisfaction_5") {
    const result = csatResult(buckets);
    return result ? { kind: "csat", ...result } : null;
  }
  return null;
}

/**
 * The option ids an answer chose. Yes/No's canonical value is `numberValue`
 * (1/0); the `["yes"]`/`["no"]` mirror is only a convenience, so older answers
 * without it still count.
 */
function choiceIds(type: string, answer: SurveyAnswerRow): string[] {
  if (type === "yes_no") {
    if (answer.numberValue === 1) return [YES_NO_IDS.yes];
    if (answer.numberValue === 0) return [YES_NO_IDS.no];
  }
  return [...new Set(answer.optionIds)];
}

/**
 * Still waiting for its order: an answer with an order id whose total has not
 * arrived and that the 24h sweep has not given up on. An answer with no order
 * (on-site, link) or a written-off one will never resolve, so it is not shown
 * as "Pending" forever.
 */
export function isPendingResponse(row: Pick<SurveyResponseRow, "orderId" | "orderTotal" | "unverifiedFailed">): boolean {
  return row.orderId !== null && row.orderTotal === null && !row.unverifiedFailed;
}

/**
 * Revenue in one currency and the counted orders it comes from. AOV is
 * `minor / orders` within one currency; currencies are never added together.
 */
export type CurrencyTotal = { currency: string; minor: number; orders: number };

function rollup(entries: ReadonlyArray<{ currency: string; minor: number }>): CurrencyTotal[] {
  const totals = new Map<string, { minor: number; orders: number }>();
  for (const { currency, minor } of entries) {
    const current = totals.get(currency) ?? { minor: 0, orders: 0 };
    const next = current.minor + minor;
    // An overflowing sum is dropped with its order, so AOV stays consistent.
    if (Number.isSafeInteger(next)) totals.set(currency, { minor: next, orders: current.orders + 1 });
  }
  return [...totals.entries()]
    .map(([currency, total]) => ({ currency, ...total }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Average order value in minor units, or null with no counted orders. */
export function aovMinor(total: Pick<CurrencyTotal, "minor" | "orders">): number | null {
  if (total.orders <= 0) return null;
  return Math.round(total.minor / total.orders);
}

/** Answers from one kind of buyer, and the revenue their orders brought. */
export type BuyerGroup = { responses: number; revenueByCurrency: CurrencyTotal[] };

export type SurveySummary = {
  totalResponses: number;
  pendingResponses: number;
  flaggedResponses: number;
  /** Counted revenue per currency, with its order count for AOV. */
  revenueByCurrency: CurrencyTotal[];
  countsByPlacement: Array<{ placement: string; count: number }>;
  /** First-time vs returning buyers; `unknown` when the checkout did not say. */
  buyers: { first: BuyerGroup; returning: BuyerGroup; unknown: number };
};

export function summariseSurvey(responses: ReadonlyArray<SurveyResponseRow>): SurveySummary {
  const revenue: Array<{ currency: string; minor: number }> = [];
  let pending = 0;
  let flagged = 0;
  const byPlacement = new Map<string, number>();
  const firstRevenue: Array<{ currency: string; minor: number }> = [];
  const returningRevenue: Array<{ currency: string; minor: number }> = [];
  let first = 0;
  let returning = 0;
  let unknown = 0;

  for (const response of responses) {
    if (response.flagged) flagged += 1;
    if (isPendingResponse(response)) pending += 1;
    byPlacement.set(response.placement, (byPlacement.get(response.placement) ?? 0) + 1);
    if (response.isFirstOrder === true) first += 1;
    else if (response.isFirstOrder === false) returning += 1;
    else unknown += 1;
    const decision = decideSurveyRevenue(response);
    if (decision.included && response.order) {
      const entry = { currency: response.order.currency, minor: decision.minor };
      revenue.push(entry);
      if (response.isFirstOrder === true) firstRevenue.push(entry);
      else if (response.isFirstOrder === false) returningRevenue.push(entry);
    }
  }

  return {
    totalResponses: responses.length,
    pendingResponses: pending,
    flaggedResponses: flagged,
    revenueByCurrency: rollup(revenue),
    countsByPlacement: [...byPlacement.entries()]
      .map(([placement, count]) => ({ placement, count }))
      .sort((a, b) => b.count - a.count),
    buyers: {
      first: { responses: first, revenueByCurrency: rollup(firstRevenue) },
      returning: { responses: returning, revenueByCurrency: rollup(returningRevenue) },
      unknown,
    },
  };
}

/**
 * Answer rate per survey: of the real orders placed while the survey existed
 * (inside the chosen window), how many answered it. Test, cancelled and POS
 * orders are left out of both sides, as on the channel report: none of them
 * could have been asked. A survey shown only to some buyers (targeting,
 * sampling) reads lower, and the page says so.
 *
 * One small indexed count per survey; a shop has at most MAX_SURVEYS_TOTAL.
 */
export async function surveyAnswerRates(params: {
  shopId: string;
  surveys: ReadonlyArray<{ id: string; createdAt: Date }>;
  /** Null: all time. */
  start: Date | null;
  end: Date;
}): Promise<Map<string, { answered: number; orders: number }>> {
  const results = await Promise.all(
    params.surveys.map(async (survey) => {
      const from = params.start && params.start > survey.createdAt ? params.start : survey.createdAt;
      const rows = await retryDb(() =>
        db.$queryRaw<Array<{ orders: bigint; answered: bigint }>>`
          SELECT
            COUNT(*)::bigint AS orders,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM "Response" r
                WHERE r."shopId" = o."shopId" AND r."surveyId" = ${survey.id} AND r."orderId" = o."orderId"
              )
            )::bigint AS answered
          FROM "OrderCache" o
          WHERE o."shopId" = ${params.shopId}
            AND o."createdAtShop" >= ${from} AND o."createdAtShop" < ${params.end}
            AND o."isTest" = false AND o."isCancelled" = false
            AND ${couldSeeSurveySql("o")}
        `,
      );
      const row = rows[0];
      return [survey.id, { orders: Number(row?.orders ?? 0), answered: Number(row?.answered ?? 0) }] as const;
    }),
  );
  return new Map(results);
}

/** Whole-percent answer rate, capped at 100; null with no orders to compare. */
export function answerRatePercent(rate: { answered: number; orders: number } | undefined): number | null {
  if (!rate || rate.orders <= 0) return null;
  return Math.min(100, Math.round((rate.answered / rate.orders) * 100));
}

export function surveyWindowBounds(days: number, now = new Date()) {
  return { ...windowBounds(days, now), previous: previousWindowBounds(days, now) };
}
