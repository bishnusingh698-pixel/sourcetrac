/**
 * Analytics aggregation. Pure functions over already-fetched rows, so the maths
 * is unit-testable without a database and the route stays a thin shell.
 *
 * All windows are UTC and half-open [start, end) (docs/03 FLOW 15).
 */

import { averageOrderValue, percentChange, type CurrencyCode } from "./money";
import { rollupByCurrency } from "./revenue";

export const TREND_WINDOWS = [7, 30, 90] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

export function isTrendWindow(value: unknown): value is TrendWindow {
  return typeof value === "number" && (TREND_WINDOWS as readonly number[]).includes(value);
}

/** Half-open UTC window ending at `now`. */
export function windowBounds(days: number, now = new Date()): { start: Date; end: Date } {
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

export function previousWindowBounds(days: number, now = new Date()): { start: Date; end: Date } {
  const { start, end } = windowBounds(days, now);
  return {
    start: new Date(start.getTime() - days * 24 * 60 * 60 * 1000),
    end: start,
  };
}

export type ResponseRow = {
  channel: string;
  submittedAt: Date;
  isLocked: boolean;
  reconciled: boolean;
  unreconcilable: boolean;
};

export type DecidedAmount = {
  channel: string;
  currency: CurrencyCode;
  minor: number;
  /** Response timestamp, used to attribute revenue to a trend day. */
  submittedAt: Date;
};

export type ChannelStat = {
  channel: string;
  responses: number;
  lockedResponses: number;
  pendingResponses: number;
  /** Revenue split by currency. Never a single combined number. */
  revenueByCurrency: Array<{ currency: CurrencyCode; minor: number }>;
  /** AOV per currency. Entry absent when there is no countable revenue. */
  aovByCurrency: Array<{ currency: CurrencyCode; minor: number }>;
  /** Orders that actually contributed revenue, per currency. The AOV denominator. */
  revenueOrdersByCurrency: Array<{ currency: CurrencyCode; count: number }>;
};

export type Summary = {
  totalResponses: number;
  lockedResponses: number;
  pendingResponses: number;
  revenueByCurrency: Array<{ currency: CurrencyCode; minor: number }>;
  aovByCurrency: Array<{ currency: CurrencyCode; minor: number }>;
  /** Orders that actually contributed revenue, per currency. The AOV denominator. */
  revenueOrdersByCurrency: Array<{ currency: CurrencyCode; count: number }>;
  /** null when there are no orders in the window; rendered as an em dash. */
  responseRate: number | null;
  responseRateChange: number | null;
};

/**
 * Build per-channel and overall statistics.
 *
 * `ordersInWindow` is the count of eligible (non-test, non-cancelled) orders
 * from orders_cache for the same window — the denominator for response rate.
 *
 * AOV is revenue divided by the number of orders that actually contributed
 * revenue, counted per currency. That count cannot be derived from the response
 * total: `evaluateRevenue` also excludes test, cancelled, voided and fully
 * refunded orders, and none of those are "pending". Counting them would silently
 * understate AOV on any store that has ever taken a refund.
 */
export function computeStats(params: {
  responses: ReadonlyArray<ResponseRow>;
  decidedAmounts: ReadonlyArray<DecidedAmount>;
  ordersInWindow: number;
  previousResponsesCount?: number;
}): { summary: Summary; channels: ChannelStat[] } {
  const { responses, decidedAmounts, ordersInWindow, previousResponsesCount } = params;

  const responseCountByChannel = new Map<string, number>();
  const lockedByChannel = new Map<string, number>();
  const pendingByChannel = new Map<string, number>();

  for (const row of responses) {
    responseCountByChannel.set(row.channel, (responseCountByChannel.get(row.channel) ?? 0) + 1);

    if (row.isLocked) {
      lockedByChannel.set(row.channel, (lockedByChannel.get(row.channel) ?? 0) + 1);
    }
    // "Pending" means we have no revenue figure — explicitly not $0.00.
    if (!row.reconciled || row.unreconcilable) {
      pendingByChannel.set(row.channel, (pendingByChannel.get(row.channel) ?? 0) + 1);
    }
  }

  // One entry per decided order, so counting the rows gives the true denominator
  // per currency. Grouped here once rather than per channel so the summary and
  // every channel row agree on what "an order with revenue" means.
  const amountsByChannel = new Map<string, Array<{ currency: CurrencyCode; minor: number }>>();
  for (const entry of decidedAmounts) {
    const existing = amountsByChannel.get(entry.channel) ?? [];
    existing.push({ currency: entry.currency, minor: entry.minor });
    amountsByChannel.set(entry.channel, existing);
  }

  const channels: ChannelStat[] = [...responseCountByChannel.keys()]
    .map((channel) => {
      const rolled = rollupByCurrency(amountsByChannel.get(channel) ?? []);
      const orderCounts = rollupCountsByCurrency(amountsByChannel.get(channel) ?? []);
      const countFor = (currency: CurrencyCode) => orderCounts.find((e) => e.currency === currency)?.count ?? 0;

      return {
        channel,
        responses: responseCountByChannel.get(channel) ?? 0,
        lockedResponses: lockedByChannel.get(channel) ?? 0,
        pendingResponses: pendingByChannel.get(channel) ?? 0,
        revenueByCurrency: rolled,
        aovByCurrency: rolled
          .map(({ currency, minor }) => ({
            currency,
            minor: averageOrderValue(minor, countFor(currency)),
          }))
          .filter((entry): entry is { currency: CurrencyCode; minor: number } => entry.minor !== null),
        revenueOrdersByCurrency: orderCounts,
      };
    })
    .sort((a, b) => b.responses - a.responses);

  const totalResponses = responses.length;
  const pendingResponses = [...pendingByChannel.values()].reduce((sum, n) => sum + n, 0);
  const totalAmounts = decidedAmounts.map(({ currency, minor }) => ({ currency, minor }));
  const totalRevenue = rollupByCurrency(totalAmounts);
  const totalOrderCounts = rollupCountsByCurrency(totalAmounts);

  const summary: Summary = {
    totalResponses,
    lockedResponses: [...lockedByChannel.values()].reduce((sum, n) => sum + n, 0),
    pendingResponses,
    revenueByCurrency: totalRevenue,
    aovByCurrency: totalRevenue
      .map(({ currency, minor }) => ({
        currency,
        minor: averageOrderValue(minor, totalOrderCounts.find((e) => e.currency === currency)?.count ?? 0),
      }))
      .filter((entry): entry is { currency: CurrencyCode; minor: number } => entry.minor !== null),
    revenueOrdersByCurrency: totalOrderCounts,
    // Divide-by-zero guard: zero orders yields null, rendered as "—".
    responseRate:
      ordersInWindow > 0 && Number.isFinite(ordersInWindow) ? (totalResponses / ordersInWindow) * 100 : null,
    responseRateChange:
      previousResponsesCount === undefined
        ? null
        : percentChange(totalResponses, previousResponsesCount),
  };

  return { summary, channels };
}

/** Count rows per currency. The AOV denominator, kept separate from any money sum. */
function rollupCountsByCurrency(
  entries: ReadonlyArray<{ currency: CurrencyCode; minor: number }>,
): Array<{ currency: CurrencyCode; count: number }> {
  const counts = new Map<CurrencyCode, number>();
  for (const { currency } of entries) {
    counts.set(currency, (counts.get(currency) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export type TrendPoint = {
  /** ISO date in UTC, e.g. "2026-10-01". */
  date: string;
  responses: number;
  revenueByCurrency: Array<{ currency: CurrencyCode; minor: number }>;
};

/**
 * Bucket responses into daily UTC points. Days with no responses are emitted as
 * zero rather than omitted, so the trend line has no misleading gaps.
 */
export function buildTrend(params: {
  responses: ReadonlyArray<ResponseRow>;
  decidedAmounts: ReadonlyArray<DecidedAmount>;
  days: number;
  now?: Date;
}): TrendPoint[] {
  const { responses, decidedAmounts, days, now = new Date() } = params;
  const { end } = windowBounds(days, now);

  // Anchor on the window end so the last point is the current UTC day. Counting
  // forward from the window start stopped at yesterday and silently dropped
  // every response submitted today from the chart.
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    dayKeys.push(toUtcDateKey(new Date(end.getTime() - i * 24 * 60 * 60 * 1000)));
  }

  const dayKeySet = new Set(dayKeys);
  const responsesByDay = new Map<string, number>();
  for (const row of responses) {
    const key = toUtcDateKey(row.submittedAt);
    if (!dayKeySet.has(key)) continue;
    responsesByDay.set(key, (responsesByDay.get(key) ?? 0) + 1);
  }

  const revenueByDay = new Map<string, Array<{ currency: CurrencyCode; minor: number }>>();
  for (const entry of decidedAmounts) {
    const key = toUtcDateKey(entry.submittedAt);
    if (!dayKeySet.has(key)) continue;
    const bucket = revenueByDay.get(key) ?? [];
    bucket.push({ currency: entry.currency, minor: entry.minor });
    revenueByDay.set(key, bucket);
  }

  return dayKeys.map((date) => ({
    date,
    responses: responsesByDay.get(date) ?? 0,
    revenueByCurrency: rollupByCurrency(revenueByDay.get(date) ?? []),
  }));
}

/** UTC date key. Never uses local time — a merchant's timezone must not shift buckets. */
export function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
