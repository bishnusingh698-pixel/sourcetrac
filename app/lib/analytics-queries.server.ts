import { Prisma } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { previousWindowBounds, windowBounds } from "~/lib/analytics";
import { formatTimestamp, orderAdminLink, resolveExportTimeZone, type CsvRow, type RevenueStatus } from "~/lib/csv";
import { minorToDecimalString, parseMoneyToMinor } from "~/lib/money";
import { evaluateResponseRevenue, type RevenueDecision } from "~/lib/revenue";
import { OTHER_CHANNEL_VALUE, parseSurveySettings } from "~/lib/settings";
import { readableChannelKey } from "~/lib/channel-key";
import { withRetry } from "~/lib/retry.server";
import { couldSeeSurveySql, couldSeeSurveyWhere } from "~/lib/order-sources";

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
  /** Only buyers who checked out in this country (ISO alpha-2), F6. */
  country?: string | null;
}): Promise<ResponseWithOrder[]> {
  const keys = await channelKeysForShop(params.shopId);
  // A channel is asked for by its shared key; the stored answers carry each
  // survey's own option id for it.
  const rawChannels = params.channel
    ? [params.channel, ...[...keys.entries()].filter(([, key]) => key === params.channel).map(([raw]) => raw)]
    : [];
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
      FROM (${channelAnswersSql(params.shopId)}) r
      LEFT JOIN "OrderCache" o
        ON o."shopId" = ${params.shopId} AND o."orderId" = r."orderId"
      WHERE TRUE
        ${params.start ? Prisma.sql`AND r."submittedAt" >= ${params.start}` : Prisma.empty}
        ${params.end ? Prisma.sql`AND r."submittedAt" < ${params.end}` : Prisma.empty}
        ${params.channel ? Prisma.sql`AND r.channel IN (${Prisma.join(rawChannels)})` : Prisma.empty}
        ${params.country ? Prisma.sql`AND r.country = ${params.country}` : Prisma.empty}
      ORDER BY r."submittedAt" DESC, r.id DESC
      ${params.limit ? Prisma.sql`LIMIT ${params.limit}` : Prisma.empty}
    `,
  );

  return rows.map((row) => toResponseWithOrder({ ...row, channel: keys.get(row.channel) ?? row.channel }));
}

/**
 * Every v2 option id of the shop's surveys -> its shared channel key
 * (`readableChannelKey`), so one channel is one row whichever survey asked.
 */
async function channelKeysForShop(shopId: string): Promise<Map<string, string>> {
  const options = await retryDb(() =>
    db.option.findMany({
      where: { question: { survey: { shopId } } },
      select: { id: true, label: true, isOther: true, templateKey: true, question: { select: { templateKey: true } } },
    }),
  );
  return new Map(
    options.map((option) => [
      option.id,
      readableChannelKey({
        shopId,
        optionId: option.id,
        optionTemplateKey: option.templateKey,
        questionTemplateKey: option.question.templateKey,
        label: option.label,
        isOther: option.isOther,
      }),
    ]),
  );
}

/**
 * Every channel answer for a shop, from both stores, in one shape.
 *
 * - The legacy `SurveyResponse` rows that the multi-question migration did not
 *   copy (the old single-question route still writes them), and
 * - every v2 `Response` (which includes the migrated history, `bf-response-*`)
 *   that answered its survey's channel-report question.
 *
 * The checkout blocks write only v2, so reading `SurveyResponse` alone left the
 * dashboard and export empty for every shop installed after that release.
 *
 * A v2 answer's channel is the chosen option id. Migrated options carry the
 * legacy channel value in their id (`bf-option-<shop>-<value>`); that prefix is
 * stripped so history and post-migration legacy rows stay one channel. Revenue
 * is decided the same way for both: a v2 row with a stored total is
 * "reconciled", and one the 24h sweep gave up on is "unreconcilable". An
 * answer with no order id (on-site and link placements) cannot carry revenue
 * and is not part of this order-level report.
 */
function channelAnswersSql(shopId: string): Prisma.Sql {
  const bfPrefix = `bf-option-${shopId}-`;
  return Prisma.sql`
    SELECT
      l.id, l."orderId", l.channel, l."otherText", l."submittedAt", l."isLocked",
      l.reconciled, l."unreconcilable",
      -- The single-question survey never recorded where the buyer was.
      NULL::text AS country
    FROM "SurveyResponse" l
    WHERE l."shopId" = ${shopId}
      AND NOT EXISTS (SELECT 1 FROM "Response" b WHERE b.id = 'bf-response-' || l.id)
    UNION ALL
    SELECT
      v.id,
      v."orderId",
      CASE
        WHEN starts_with(a."optionIds"::jsonb ->> 0, ${bfPrefix})
          THEN substr(a."optionIds"::jsonb ->> 0, ${bfPrefix.length + 1}::int)
        ELSE a."optionIds"::jsonb ->> 0
      END AS channel,
      a."otherText",
      v."createdAt" AS "submittedAt",
      v.flagged AS "isLocked",
      (v."orderTotal" IS NOT NULL) AS reconciled,
      v."unverifiedFailed" AS "unreconcilable",
      v.country
    FROM "Response" v
    JOIN "Survey" s ON s.id = v."surveyId"
    JOIN "Answer" a ON a."responseId" = v.id AND a."questionId" = s."channelReportQuestionId"
    WHERE v."shopId" = ${shopId}
      AND v."orderId" IS NOT NULL
      AND jsonb_typeof(a."optionIds"::jsonb) = 'array'
      AND (a."optionIds"::jsonb ->> 0) IS NOT NULL
  `;
}

/** Answers per channel for a shop, from both stores, with the merchant's labels. */
export async function channelCountsForShop(shopId: string): Promise<Array<{ channel: string; label: string; count: number }>> {
  const [rows, shop, keys] = await Promise.all([
    retryDb(() =>
      db.$queryRaw<Array<{ channel: string; count: bigint }>>`
        SELECT r.channel, COUNT(*)::bigint AS count FROM (${channelAnswersSql(shopId)}) r
        GROUP BY r.channel ORDER BY count DESC
      `,
    ),
    retryDb(() => db.shop.findUnique({ where: { id: shopId }, select: { id: true, optionsJson: true, questionText: true } })),
    channelKeysForShop(shopId),
  ]);
  const labels = shop ? await fetchChannelLabels(shop) : new Map<string, string>();
  const merged = new Map<string, number>();
  for (const row of rows) {
    const channel = keys.get(row.channel) ?? row.channel;
    merged.set(channel, (merged.get(channel) ?? 0) + Number(row.count));
  }
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([channel, count]) => ({ channel, label: channelLabel(channel, labels), count }));
}

/**
 * The countries buyers answered from (v2 answers only; the single-question
 * survey never recorded one), busiest first, for the Analytics country filter.
 * With `surveyId`, only that survey's answers, so the counts beside each
 * country match the page that lists one survey.
 */
export async function answerCountries(
  shopId: string,
  surveyId?: string | null,
): Promise<Array<{ code: string; count: number }>> {
  const rows = await retryDb(() =>
    db.response.groupBy({
      by: ["country"],
      where: { shopId, ...(surveyId ? { surveyId } : {}), country: { not: null } },
      _count: { _all: true },
    }),
  );
  return rows
    .flatMap((row) => (row.country ? [{ code: row.country, count: row._count._all }] : []))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Whether the shop has any answer at all, in either store. Two indexed lookups. */
export async function hasAnyAnswer(shopId: string): Promise<boolean> {
  const [legacy, v2] = await Promise.all([
    retryDb(() => db.surveyResponse.findFirst({ where: { shopId }, select: { id: true } })),
    retryDb(() => db.response.findFirst({ where: { shopId }, select: { id: true } })),
  ]);
  return legacy !== null || v2 !== null;
}

/** How many channel answers the shop has in total (the Export page count). */
export async function countChannelAnswers(shopId: string): Promise<number> {
  const rows = await retryDb(() =>
    db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM (${channelAnswersSql(shopId)}) r`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Channel key -> the merchant's label: the single-question settings' labels,
 * plus every option of the shop's surveys (archived included, so a removed
 * option keeps its name in reports).
 */
export async function fetchChannelLabels(shop: {
  id: string;
  optionsJson: string;
  questionText: string;
}): Promise<Map<string, string>> {
  const labels = new Map(
    parseSurveySettings(shop.optionsJson, { questionText: shop.questionText, options: [], allowOther: false }).options.map(
      (option) => [option.value, option.label] as const,
    ),
  );
  const options = await retryDb(() =>
    db.option.findMany({
      where: { question: { survey: { shopId: shop.id } } },
      select: { id: true, label: true, isOther: true, templateKey: true, question: { select: { templateKey: true } } },
    }),
  );
  for (const option of options) {
    const key = readableChannelKey({
      shopId: shop.id,
      optionId: option.id,
      optionTemplateKey: option.templateKey,
      questionTemplateKey: option.question.templateKey,
      label: option.label,
      isOther: option.isOther,
    });
    if (!labels.has(key)) labels.set(key, option.label);
  }
  return labels;
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
export async function countResponsesInWindow(params: {
  shopId: string;
  start: Date;
  end: Date;
  country?: string | null;
}): Promise<number> {
  const rows = await retryDb(() =>
    db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM (${channelAnswersSql(params.shopId)}) r
      WHERE r."submittedAt" >= ${params.start} AND r."submittedAt" < ${params.end}
        ${params.country ? Prisma.sql`AND r.country = ${params.country}` : Prisma.empty}
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * The response rate's numerator: eligible orders PLACED in the window that have
 * an answer, whenever it was given. Counting answers by their own date against
 * orders by theirs let late Order-status answers push the rate past 100%.
 */
export async function countAnsweredEligibleOrdersInWindow(params: {
  shopId: string;
  start: Date;
  end: Date;
}): Promise<number> {
  const start = await askableFrom(params.shopId, params.start);
  const rows = await retryDb(() =>
    db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "OrderCache" o
      WHERE o."shopId" = ${params.shopId}
        AND o."createdAtShop" >= ${start} AND o."createdAtShop" < ${params.end}
        AND o."isTest" = false AND o."isCancelled" = false
        AND ${couldSeeSurveySql("o")}
        -- A semi-join on the answers' order ids, evaluated once, not a
        -- correlated subquery over the whole union per order.
        AND o."orderId" IN (SELECT r."orderId" FROM (${channelAnswersSql(params.shopId)}) r)
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Denominator for response rate: eligible orders in the window.
 * Test, cancelled and POS orders are excluded so the rate is honest: none of
 * them could have been asked.
 */
export async function countEligibleOrdersInWindow(params: { shopId: string; start: Date; end: Date }): Promise<number> {
  const start = await askableFrom(params.shopId, params.start);
  return retryDb(() =>
    db.orderCache.count({
      where: {
        shopId: params.shopId,
        createdAtShop: { gte: start, lt: params.end },
        isTest: false,
        isCancelled: false,
        ...couldSeeSurveyWhere,
      },
    }),
  );
}

/**
 * The start of the rate's window, never before the app was first installed.
 * Orders from before then could not have been asked, and the only ones cached
 * are those the backfill fetched because they have an answer, so counting them
 * pushed the rate up for any window reaching back past the install.
 */
async function askableFrom(shopId: string, start: Date): Promise<Date> {
  const shop = await retryDb(() => db.shop.findUnique({ where: { id: shopId }, select: { createdAt: true } }));
  return shop && shop.createdAt > start ? shop.createdAt : start;
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

export async function fetchDashboardData(params: {
  shopId: string;
  days: number;
  now?: Date;
  /** The store's IANA zone: range edges are its midnights. */
  timeZone?: string | null;
  /**
   * Only buyers in this country (F6). Orders do not record the buyer's
   * country, so there is no honest response rate for one country: the rate's
   * counts are left at zero and the report says the rate is not available.
   */
  country?: string | null;
}) {
  const now = params.now ?? new Date();
  const { start, end } = windowBounds(params.days, now, params.timeZone);
  const previous = previousWindowBounds(params.days, now, params.timeZone);
  const country = params.country ?? null;

  const [responses, ordersInWindow, previousCount, rateResponses, anyAnswer] = await Promise.all([
    fetchResponsesInWindow({ shopId: params.shopId, start, end, country }),
    country ? Promise.resolve(0) : countEligibleOrdersInWindow({ shopId: params.shopId, start, end }),
    countResponsesInWindow({ shopId: params.shopId, start: previous.start, end: previous.end, country }),
    country ? Promise.resolve(0) : countAnsweredEligibleOrdersInWindow({ shopId: params.shopId, start, end }),
    hasAnyAnswer(params.shopId),
  ]);

  return {
    responses,
    ordersInWindow,
    previousCount,
    window: { start, end },
    decidedAmounts: toDecidedAmounts(responses),
    // Answered orders among the same eligible orders as the denominator.
    rateResponses,
    /** Any answer ever, so a shop with none in this window is not shown as brand-new. */
    anyAnswer,
  };
}
