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
import { evaluateResponseRevenue, type RevenueDecision } from "~/lib/revenue";
import { withRetry } from "~/lib/retry.server";

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
  answers: SurveyAnswerRow[];
  order: OrderFacts | null;
};

/** Load responses for a survey in a window, with their answers and order facts. */
export async function fetchSurveyResponses(params: {
  shopId: string;
  surveyId: string;
  start?: Date;
  end?: Date;
  limit?: number;
  offset?: number;
}): Promise<SurveyResponseRow[]> {
  const rows = await retryDb(() =>
    db.response.findMany({
      where: {
        shopId: params.shopId,
        surveyId: params.surveyId,
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
  const orders = orderIds.length
    ? await retryDb(() =>
        db.orderCache.findMany({
          where: { shopId: params.shopId, orderId: { in: orderIds } },
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
      )
    : [];
  const orderById = new Map(orders.map((o) => [o.orderId, o]));

  return rows.map((row) => {
    const order = row.orderId ? orderById.get(row.orderId) : undefined;
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: order?.orderNumber ?? null,
      orderTotal: row.orderTotal === null ? null : row.orderTotal.toString(),
      currency: row.currency,
      placement: row.placement,
      flagged: row.flagged,
      verified: row.verified,
      unverifiedFailed: row.unverifiedFailed,
      createdAt: row.createdAt,
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

function safeParseArray(raw: string): string[] {
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

export type QuestionBreakdown =
  | {
      kind: "choice";
      questionId: string;
      total: number;
      options: Array<{
        optionId: string;
        count: number;
        /** Net revenue attributed to answers that chose this option, per currency. */
        revenueByCurrency: Array<{ currency: string; minor: number }>;
      }>;
      otherCount: number;
    }
  | {
      kind: "numeric";
      questionId: string;
      total: number;
      distribution: Array<{ value: number; count: number }>;
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
      };
    }

    // Choice types (single / multi / dropdown / yes_no / satisfaction).
    const optionCounts = new Map<string, number>();
    const revenueByOption = new Map<string, Array<{ currency: string; minor: number }>>();
    let otherCount = 0;

    for (const response of responses) {
      const answer = response.answers.find((a) => a.questionId === question.id);
      if (!answer) continue;

      const decision = decideSurveyRevenue(response);
      const revenue = decision.included && response.order ? { currency: response.order.currency, minor: decision.minor } : null;

      for (const optionId of answer.optionIds) {
        optionCounts.set(optionId, (optionCounts.get(optionId) ?? 0) + 1);
        if (revenue) {
          const bucket = revenueByOption.get(optionId) ?? [];
          bucket.push(revenue);
          revenueByOption.set(optionId, bucket);
        }
      }
      if (answer.otherText) otherCount += 1;
    }

    const options = question.options.map((option) => ({
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
    };
  });
}

function rollup(entries: ReadonlyArray<{ currency: string; minor: number }>): Array<{ currency: string; minor: number }> {
  const totals = new Map<string, number>();
  for (const { currency, minor } of entries) {
    const next = (totals.get(currency) ?? 0) + minor;
    if (Number.isSafeInteger(next)) totals.set(currency, next);
  }
  return [...totals.entries()]
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export type SurveySummary = {
  totalResponses: number;
  pendingResponses: number;
  flaggedResponses: number;
  revenueByCurrency: Array<{ currency: string; minor: number }>;
  countsByPlacement: Array<{ placement: string; count: number }>;
};

export function summariseSurvey(responses: ReadonlyArray<SurveyResponseRow>): SurveySummary {
  const revenue: Array<{ currency: string; minor: number }> = [];
  let pending = 0;
  let flagged = 0;
  const byPlacement = new Map<string, number>();

  for (const response of responses) {
    if (response.flagged) flagged += 1;
    if (response.orderTotal === null) pending += 1;
    byPlacement.set(response.placement, (byPlacement.get(response.placement) ?? 0) + 1);
    const decision = decideSurveyRevenue(response);
    if (decision.included && response.order) {
      revenue.push({ currency: response.order.currency, minor: decision.minor });
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
  };
}

export function surveyWindowBounds(days: number, now = new Date()) {
  return { ...windowBounds(days, now), previous: previousWindowBounds(days, now) };
}
