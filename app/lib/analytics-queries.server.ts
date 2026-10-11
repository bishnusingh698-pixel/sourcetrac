import { Prisma } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { previousWindowBounds, windowBounds } from "~/lib/analytics";
import { formatTimestamp, orderAdminLink, resolveExportTimeZone, type CsvRow, type RevenueStatus } from "~/lib/csv";
import { minorToDecimalString, parseMoneyToMinor } from "~/lib/money";
import { evaluateResponseRevenue, type RevenueDecision } from "~/lib/revenue";
import { OTHER_CHANNEL_VALUE } from "~/lib/settings";
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
    /** Shopify order name, e.g. "#1001". */
    orderNumber: string | null;
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
        o."orderNumber",
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
  orderNumber: string | null;
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
  const { orderNumber, currency, totalPrice, financialStatus, isTest, isCancelled, ...response } = row;

  const hasOrder = currency !== null && isTest !== null && isCancelled !== null;

  return {
    ...response,
    order: hasOrder ? { orderNumber, currency, totalPrice, financialStatus, isTest, isCancelled } : null,
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
 * Why an answer does or does not count, as written in the CSV. Derived from the
 * same `decideRevenue` call as the dashboard, so the file and the dashboard can
 * never disagree about which orders are revenue.
 */
export function exportRevenueStatus(row: ResponseWithOrder, decision = decideRevenue(row)): RevenueStatus {
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
      // The order is cached but its total could not be read, so it never
      // reconciled. Calling that "awaiting order" would send the merchant
      // looking for an order that already arrived.
      if (row.order && row.order.totalPrice === null) return "total unreadable";
      return row.unreconcilable ? "order not received" : "awaiting order";
  }
}

/**
 * The order's net total, at its currency's precision, whenever the order is
 * known. Test, cancelled and refunded orders keep their real total: a test
 * store has only test orders, and a file of blank totals reads as broken.
 * `revenue_status` says whether the dashboard counts it.
 */
function exportOrderTotal(row: ResponseWithOrder): string | null {
  if (!row.order) return null;
  const parsed = parseMoneyToMinor(row.order.totalPrice, row.order.currency);
  if (!parsed.ok || parsed.minor < 0) return null;
  return minorToDecimalString(parsed.minor, row.order.currency);
}

export type ExportContext = {
  shopDomain: string;
  /** IANA zone from Shopify. Falls back to UTC when missing or unknown. */
  timeZone: string | null;
  /** Channel key -> the merchant's label, from the current survey settings. */
  labels: ReadonlyMap<string, string>;
};

/**
 * The merchant's own label for a channel key. A key no longer in the survey
 * (the option was deleted) has no label left, so the key itself is the best name.
 */
export function channelLabel(channel: string, labels: ReadonlyMap<string, string>): string {
  const label = labels.get(channel);
  if (label) return label;
  return channel === OTHER_CHANNEL_VALUE ? "Other" : channel;
}

/** CSV rows, one per answer, in the order given. */
export function toExportRows(rows: ReadonlyArray<ResponseWithOrder>, context: ExportContext): CsvRow[] {
  const timeZone = resolveExportTimeZone(context.timeZone);

  return rows.map((row) => {
    const decision = decideRevenue(row);
    const orderTotal = exportOrderTotal(row);

    return {
      orderName: row.order?.orderNumber ?? null,
      orderId: row.orderId,
      submittedAt: formatTimestamp(row.submittedAt, timeZone),
      timeZone,
      channel: channelLabel(row.channel, context.labels),
      otherAnswer: row.otherText,
      orderTotal,
      currency: orderTotal === null ? null : (row.order?.currency ?? null),
      revenueStatus: exportRevenueStatus(row, decision),
      orderLink: orderAdminLink(context.shopDomain, row.orderId),
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
