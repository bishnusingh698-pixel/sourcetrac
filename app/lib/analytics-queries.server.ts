import { Prisma } from "@prisma/client";

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

/**
 * `SurveyResponse` and `OrderCache` deliberately share no Prisma relation.
 *
 * They are joined on `(shopId, orderId)` because that pair is the logical link,
 * but a response can exist with no matching order — it arrives before
 * `orders/create` and stays unreconciled until the webhook lands. A `has`
 * relation would have demanded the order row and dropped those answers, which is
 * the one thing we must never do. A raw LEFT JOIN also lets us select only the
 * six revenue columns instead of every `OrderCache` column.
 *
 * `totalPrice`/`totalRefunded` are cast to text in SQL and arrive as strings.
 * The columns are `Decimal`, and a `Decimal` instance stringifies as `"19.99"`
 * via its own `toString`, which `parseMoneyToMinor` happens to accept — but it
 * is incidental, and passing the object straight into a decimal regex would be
 * rejected. Selecting the text form makes the type honest.
 *
 * Every value is a bound parameter. Nothing here is string-interpolated, so a
 * shop domain or channel containing a quote cannot alter the query.
 */
export async function fetchResponsesInWindow(params: {
  shopId: string;
  start: Date;
  end: Date;
  channel?: string;
}): Promise<ResponseWithOrder[]> {
  // Built per call rather than as a module constant because the shop id, window
  // and channel filter are all bound parameters — never string-interpolated.
  const rows = await retryDb(() =>
    db.$queryRaw<ResponseWithOrderRow[]>`
      ${RESPONSE_WITH_ORDER_SELECT}
      WHERE r."shopId" = ${params.shopId}
        AND r."submittedAt" >= ${params.start}
        AND r."submittedAt" < ${params.end}
        ${params.channel ? Prisma.sql`AND r.channel = ${params.channel}` : Prisma.empty}
      ORDER BY r."submittedAt" DESC
    `,
  );

  return rows.map(toResponseWithOrder);
}

/**
 * The shared projection, so the windowed dashboard query and the unfiltered
 * export query cannot drift into selecting different columns and disagreeing
 * about what "an order exists" means.
 *
 * Only the projection and the join are fixed here. Every value the WHERE clauses
 * bind is still a bound parameter, so this is not string interpolation of
 * anything a caller controls.
 */
const RESPONSE_WITH_ORDER_SELECT = Prisma.sql`
  SELECT
    r.id,
    r."orderId",
    r.channel,
    r."otherText",
    r."submittedAt",
    r."isLocked",
    r.reconciled,
    r.unreconcilable,
    o.currency,
    o."totalPrice"::text AS "totalPrice",
    o."totalRefunded"::text AS "totalRefunded",
    o."financialStatus",
    o."isTest",
    o."isCancelled"
  FROM "SurveyResponse" r
  LEFT JOIN "OrderCache" o
    ON o."shopId" = r."shopId" AND o."orderId" = r."orderId"
`;

/**
 * Every response for a shop, oldest first, with its order attached.
 *
 * The export has no time window -- the merchant is entitled to all of their
 * answers -- but it uses the same join and therefore the same revenue policy as
 * the dashboard, so a row in the CSV always carries the figure the dashboard
 * attributed to that channel. Reading `orderTotal` off the response row alone
 * cannot do that: a partially refunded order still has the gross total stored
 * there, no code path ever reduces it, and the file overstated revenue by the
 * refunded amount.
 *
 * `limit` exists for the export *preview*, which shows ten rows and must not
 * pull a shop's whole history into memory just to slice the last ten off it.
 */
export async function fetchAllResponsesWithOrder(
  shopId: string,
  limit?: number,
): Promise<ResponseWithOrder[]> {
  const rows = await retryDb(() =>
    db.$queryRaw<ResponseWithOrderRow[]>`
      ${RESPONSE_WITH_ORDER_SELECT}
      WHERE r."shopId" = ${shopId}
      ORDER BY r."submittedAt" DESC
      ${limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}
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
  totalRefunded: string | null;
  financialStatus: string | null;
  isTest: boolean | null;
  isCancelled: boolean | null;
};

/**
 * A LEFT JOIN with no match yields all-null order columns, so the absence of an
 * order is represented by collapsing that row to `order: null` rather than by a
 * partially-populated object. `evaluateResponseRevenue` treats both as
 * unreconciled, but a null object keeps every downstream check honest about the
 * difference between "no order yet" and "an order with no totals".
 *
 * Only the NOT NULL columns are used to detect a miss. `financialStatus` is
 * deliberately excluded: it is nullable, and Shopify leaves it null while an order
 * is unpaid or authorized-but-pending. Treating that null as "no order" silently
 * dropped real revenue from the dashboard — worse, it did so invisibly, because
 * the answer had genuinely reconciled and so was not listed as "Pending" either.
 */
function toResponseWithOrder(row: ResponseWithOrderRow): ResponseWithOrder {
  const { currency, totalPrice, totalRefunded, financialStatus, isTest, isCancelled, ...response } = row;

  const hasOrder =
    currency !== null &&
    totalPrice !== null &&
    isTest !== null &&
    isCancelled !== null;

  return {
    ...response,
    order: hasOrder
      ? {
          currency,
          totalPrice,
          // `totalRefunded` is NOT NULL in the schema with a 0 default, but the
          // column being null in a LEFT JOIN miss is indistinguishable, and a
          // missing refund amount must parse as zero rather than throw.
          totalRefunded: totalRefunded ?? "0",
          financialStatus,
          isTest,
          isCancelled,
        }
      : null,
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
