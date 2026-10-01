import { db, isRetryableDbError } from "~/db.server";
import { previousWindowBounds, windowBounds } from "~/lib/analytics";
import { evaluateResponseRevenue } from "~/lib/revenue";
import { withRetry } from "~/lib/retry.server";

/**
 * Read queries for the dashboard. Keeps SQL in one place and returns raw rows;
 * all interpretation happens in the pure modules so it stays testable.
 */

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

export type ResponseWithOrder = {
  id: string;
  orderId: string;
  channel: string;
  otherText: string | null;
  submittedAt: Date;
  isLocked: boolean;
  reconciled: boolean;
  unreconcilable: boolean;
  order: {
    currency: string;
    totalPrice: string;
    totalRefunded: string;
    financialStatus: string | null;
    isTest: boolean;
    isCancelled: boolean;
  } | null;
};

const RESPONSE_INCLUDE = {
  shop: false,
  order: true,
} as const;

export async function fetchResponsesInWindow(params: {
  shopId: string;
  start: Date;
  end: Date;
  channel?: string;
}): Promise<ResponseWithOrder[]> {
  return retryDb(() =>
    db.surveyResponse.findMany({
      where: {
        shopId: params.shopId,
        submittedAt: { gte: params.start, lt: params.end },
        ...(params.channel ? { channel: params.channel } : {}),
      },
      orderBy: { submittedAt: "desc" },
      include: RESPONSE_INCLUDE,
    }),
  );
}

/** Denormalised count, used for the previous-period comparison. */
export async function countResponsesInWindow(params: { shopId: string; start: Date; end: Date }): Promise<number> {
  return retryDb(() =>
    db.surveyResponse.count({
      where: { shopId: params.shopId, submittedAt: { gte: params.start, lt: params.end } },
    }),
  );
}

/**
 * Denominator for response rate: eligible orders in the window.
 * Test and cancelled orders are excluded so the rate is honest.
 */
export async function countEligibleOrdersInWindow(params: { shopId: string; start: Date; end: Date }): Promise<number> {
  return retryDb(() =>
    db.orderCache.count({
      where: {
        shopId: params.shopId,
        createdAtShop: { gte: params.start, lt: params.end },
        isTest: false,
        isCancelled: false,
      },
    }),
  );
}

/** Channels the merchant actually has responses for, plus their labels. */
export async function fetchChannelsWithResponseCount(shopId: string): Promise<Array<{ channel: string; count: number }>> {
  const grouped = await retryDb(() =>
    db.surveyResponse.groupBy({
      by: ["channel"],
      where: { shopId },
      _count: { channel: true },
    }),
  );

  return grouped
    .map((row) => ({ channel: row.channel, count: row._count.channel }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Convert raw rows into decided revenue amounts, applying the policy in
 * revenue.ts. Excluded rows are simply absent, and pending rows are counted
 * separately by the caller.
 */
export function toDecidedAmounts(rows: ReadonlyArray<ResponseWithOrder>): Array<{
  channel: string;
  currency: string;
  minor: number;
  submittedAt: Date;
}> {
  const decided: Array<{ channel: string; currency: string; minor: number; submittedAt: Date }> = [];

  for (const row of rows) {
    const decision = evaluateResponseRevenue(
      { reconciled: row.reconciled, unreconcilable: row.unreconcilable },
      row.order
        ? {
            currency: row.order.currency,
            totalPrice: row.order.totalPrice,
            totalRefunded: row.order.totalRefunded,
            financialStatus: row.order.financialStatus,
            isTest: row.order.isTest,
            isCancelled: row.order.isCancelled,
          }
        : null,
    );

    if (decision.included) {
      decided.push({
        channel: row.channel,
        currency: row.order?.currency ?? "USD",
        minor: decision.minor,
        submittedAt: row.submittedAt,
      });
    }
  }

  return decided;
}

export async function fetchDashboardData(params: { shopId: string; days: number; now?: Date }) {
  const now = params.now ?? new Date();
  const { start, end } = windowBounds(params.days, now);
  const previous = previousWindowBounds(params.days, now);

  const [responses, ordersInWindow, previousCount] = await Promise.all([
    fetchResponsesInWindow({ shopId: params.shopId, start, end }),
    countEligibleOrdersInWindow({ shopId: params.shopId, start, end }),
    countResponsesInWindow({ shopId: params.shopId, start: previous.start, end: previous.end }),
  ]);

  return {
    responses,
    ordersInWindow,
    previousCount,
    window: { start, end },
    decidedAmounts: toDecidedAmounts(responses),
  };
}
