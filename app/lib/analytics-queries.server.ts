import { Prisma } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { previousWindowBounds, windowBounds } from "~/lib/analytics";
import type { CsvRow } from "~/lib/csv";
import { minorToDecimalString } from "~/lib/money";
import { evaluateResponseRevenue, type RevenueDecision } from "~/lib/revenue";
import { withRetry } from "~/lib/retry.server";

/**
 * Read queries for the dashboard and the export. Keeps SQL in one place and
 * returns raw rows; all interpretation happens in the pure modules so it stays
 * testable.
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
    /** `current_total_price`, already net of refunds. Null = unparseable. */
    totalPrice: string | null;
    financialStatus: string | null;
    isTest: boolean;
    isCancelled: boolean;
  } | null;
};

/**
 * `SurveyResponse` and `OrderCache` deliberately share no Prisma relation.
 *
 * They are joined on `(shopId, orderId)` because that pair is the logical link,
 * but a response can exist with no matching order: it arrives before
 * `orders/create` and stays unreconciled until the webhook lands. A `has`
 * relation would have demanded the order row and dropped those answers, which is
 * the one thing we must never do. A raw LEFT JOIN also lets us select only the
 * revenue columns instead of every `OrderCache` column.
 *
 * `totalPrice` is cast to text in SQL and arrives as a string, so the type is
 * honest and `parseMoneyToMinor` never sees a Decimal object.
 *
 * Every value is a bound parameter. Nothing here is string-interpolated, so a
 * shop domain or channel containing a quote cannot alter the query.
 *
 * `start` and `end` are optional so the export can read every answer through the
 * very same query, and therefore the very same revenue decision, as the dashboard.
 */
export async function fetchResponsesInWindow(params: {
  shopId: string;
  start?: Date;
  end?: Date;
  channel?: string;
  limit?: number;
}): Promise<ResponseWithOrder[]> {
  const rows = await retryDb(() =>
    db.$queryRaw<ResponseWithOrderRow[]>`
      SELECT
        r.id,
        r."orderId",
        r.channel,
        r."otherText",
        r."submittedAt",
        r."isLocked",
        r.reconciled,
        r."unreconcilable",
        o.currency,
        o."totalPrice"::text AS "totalPrice",
        o."financialStatus",
        o."isTest",
        o."isCancelled"
      FROM "SurveyResponse" r
      LEFT JOIN "OrderCache" o
        ON o."shopId" = r."shopId" AND o."orderId" = r."orderId"
      WHERE r."shopId" = ${params.shopId}
        ${params.start ? Prisma.sql`AND r."submittedAt" >= ${params.start}` : Prisma.empty}
        ${params.end ? Prisma.sql`AND r."submittedAt" < ${params.end}` : Prisma.empty}
        ${params.channel ? Prisma.sql`AND r.channel = ${params.channel}` : Prisma.empty}
      ORDER BY r."submittedAt" DESC, r.id DESC
      ${params.limit ? Prisma.sql`LIMIT ${params.limit}` : Prisma.empty}
    `,
  );

  return rows.map(toResponseWithOrder);
}

type ResponseWithOrderRow = {
  id: string;
  orderId: string;
  channel: string;
  otherText: string | null;
  submittedAt: Date;
  isLocked: boolean;
  reconciled: boolean;
  unreconcilable: boolean;
  currency: string | null;
  totalPrice: string | null;
  financialStatus: string | null;
  isTest: boolean | null;
  isCancelled: boolean | null;
};

/**
 * A LEFT JOIN with no match yields all-null order columns, so the absence of an
 * order is represented by collapsing that row to `order: null` rather than by a
 * partially-populated object.
 *
 * Only the NOT NULL columns (`currency`, `isTest`, `isCancelled`) detect a miss.
 * `financialStatus` and `totalPrice` are both nullable: Shopify leaves the status
 * null while an order is unpaid, and `totalPrice` is null when the webhook total
 * could not be parsed. Treating either null as "no order" would drop a real order.
 */
function toResponseWithOrder(row: ResponseWithOrderRow): ResponseWithOrder {
  const { currency, totalPrice, financialStatus, isTest, isCancelled, ...response } = row;

  const hasOrder = currency !== null && isTest !== null && isCancelled !== null;

  return {
    ...response,
    order: hasOrder ? { currency, totalPrice, financialStatus, isTest, isCancelled } : null,
  };
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
 * THE revenue decision for one answer. The dashboard, the analytics rollups and
 * the CSV export all go through this function, so the numbers cannot diverge.
 */
export function decideRevenue(row: ResponseWithOrder): RevenueDecision {
  return evaluateResponseRevenue(
    { reconciled: row.reconciled, unreconcilable: row.unreconcilable },
    row.order
      ? {
          currency: row.order.currency,
          totalPrice: row.order.totalPrice,
          financialStatus: row.order.financialStatus,
          isTest: row.order.isTest,
          isCancelled: row.order.isCancelled,
        }
      : null,
  );
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
    const decision = decideRevenue(row);

    if (decision.included && row.order) {
      decided.push({
        channel: row.channel,
        currency: row.order.currency,
        minor: decision.minor,
        submittedAt: row.submittedAt,
      });
    }
  }

  return decided;
}

/**
 * CSV rows built from the same decision as the dashboard.
 *
 * `order_total` is the decided net amount in the order's currency, written from
 * integer minor units so it carries the currency's true precision. It is blank,
 * with a blank currency, whenever the dashboard would not count the answer's
 * revenue: pending, cancelled, test, voided, fully refunded or unparseable. A
 * blank cell therefore always means "not counted", never "free".
 */
export function toExportRows(rows: ReadonlyArray<ResponseWithOrder>): CsvRow[] {
  return rows.map((row) => {
    const decision = decideRevenue(row);
    const counted = decision.included && row.order !== null;

    return {
      orderId: row.orderId,
      submittedAt: row.submittedAt,
      channel: row.channel,
      orderTotal:
        decision.included && row.order ? minorToDecimalString(decision.minor, row.order.currency) : null,
      currency: counted && row.order ? row.order.currency : null,
    };
  });
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
