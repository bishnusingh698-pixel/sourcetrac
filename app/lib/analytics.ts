/**
 * Analytics aggregation. Pure functions over already-fetched rows, so the maths
 * is unit-testable without a database and the route stays a thin shell.
 *
 * Windows are half-open [start, end) and cut at midnight in the store's own
 * time zone (UTC when it is not known), so "last 7 days" and each trend day
 * are the merchant's calendar days. Billing periods are separate and stay UTC.
 */

import { addDaysToKey, dayKeyInZone, startOfDayInZone } from "@shared/zoned-date";
import { averageOrderValue, percentChange, type CurrencyCode } from "./money";
import { rollupByCurrency } from "./revenue";

export const TREND_WINDOWS = [7, 30, 90] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

export function isTrendWindow(value: unknown): value is TrendWindow {
  return typeof value === "number" && (TREND_WINDOWS as readonly number[]).includes(value);
}

/**
 * Half-open window `[start, now)` covering `days` calendar days in the store's
 * zone: today so far plus the `days - 1` whole days before it.
 *
 * `start` sits on a midnight of the store's day, never mid-day. A rolling
 * `now - days` start made the summary count the afternoon before the first
 * chart bucket while the chart (which buckets by calendar day) left it out, so
 * the two disagreed. A UTC midnight had the same problem for every store not
 * on UTC: in California the window began at 16:00 the day before.
 */
export function windowBounds(days: number, now = new Date(), timeZone?: string | null): { start: Date; end: Date } {
  const end = new Date(now.getTime());
  const today = dayKeyInZone(now, timeZone);
  const start = startOfDayInZone(addDaysToKey(today, -(days - 1)), timeZone);
  return { start, end };
}

/** The window of identical length immediately before the current one. */
export function previousWindowBounds(days: number, now = new Date(), timeZone?: string | null): { start: Date; end: Date } {
  const { start, end } = windowBounds(days, now, timeZone);
  const length = end.getTime() - start.getTime();
  return {
    start: new Date(start.getTime() - length),
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
  /** The response-rate numerator: answers not on a test or cancelled order. */
  rateResponses: number;
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
  /**
   * Answers whose order is not known to be a test or cancelled order. The rate's
   * denominator excludes those orders, so the numerator must too; counting every
   * answer let a test-heavy store read over 100%. Defaults to every answer.
   */
  rateResponses?: number;
  previousResponsesCount?: number;
}): { summary: Summary; channels: ChannelStat[] } {
  const { responses, decidedAmounts, ordersInWindow, previousResponsesCount } = params;
  const rateResponses = params.rateResponses ?? responses.length;

  const responseCountByChannel = new Map<string, number>();
  const lockedByChannel = new Map<string, number>();
  const pendingByChannel = new Map<string, number>();

  for (const row of responses) {
    responseCountByChannel.set(row.channel, (responseCountByChannel.get(row.channel) ?? 0) + 1);

    if (row.isLocked) {
      lockedByChannel.set(row.channel, (lockedByChannel.get(row.channel) ?? 0) + 1);
    }
    // "Pending" means we are still waiting for the order — explicitly not
    // $0.00. An answer whose order was given up on (`unreconcilable`) is not
    // waiting for anything, so it is not shown as pending forever.
    if (!row.reconciled && !row.unreconcilable) {
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
      ordersInWindow > 0 && Number.isFinite(ordersInWindow) ? (rateResponses / ordersInWindow) * 100 : null,
    rateResponses,
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
  /** The store's calendar day, e.g. "2026-10-01". */
  date: string;
  responses: number;
  revenueByCurrency: Array<{ currency: CurrencyCode; minor: number }>;
};

/**
 * Bucket responses into the store's calendar days. Days with no responses are
 * emitted as zero rather than omitted, so the trend line has no misleading gaps.
 */
export function buildTrend(params: {
  responses: ReadonlyArray<ResponseRow>;
  decidedAmounts: ReadonlyArray<DecidedAmount>;
  days: number;
  now?: Date;
  /** The store's IANA zone; UTC when absent. */
  timeZone?: string | null;
}): TrendPoint[] {
  const { responses, decidedAmounts, days, now = new Date(), timeZone } = params;

  // One key per calendar day, counted on the dates themselves (not by adding
  // 24 hours), so a daylight-saving day is still exactly one bucket and the
  // last key is the store's today.
  const today = dayKeyInZone(now, timeZone);
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) dayKeys.push(addDaysToKey(today, -i));

  const dayKeySet = new Set(dayKeys);
  const responsesByDay = new Map<string, number>();
  for (const row of responses) {
    const key = dayKeyInZone(row.submittedAt, timeZone);
    if (!dayKeySet.has(key)) continue;
    responsesByDay.set(key, (responsesByDay.get(key) ?? 0) + 1);
  }

  const revenueByDay = new Map<string, Array<{ currency: CurrencyCode; minor: number }>>();
  for (const entry of decidedAmounts) {
    const key = dayKeyInZone(entry.submittedAt, timeZone);
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

/** UTC date key, for the stores whose zone is not known. */
export function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The channel to headline: the one that brought in the most revenue.
 *
 * Revenue is never compared across currencies, so the comparison is made in
 * the shop's main currency: the one with the most counted orders (amounts in
 * different currencies, in their own minor units, cannot rank currencies:
 * 5,000 yen is not more than 49.99 dollars). A window
 * with no counted revenue yet (every order pending, or a test store) falls back
 * to the channel with the most answers, flagged `byRevenue: false` so the copy
 * does not claim money it cannot show. Ties keep the busier channel first.
 */
export function pickTopChannel(
  channels: ReadonlyArray<Pick<ChannelStat, "channel" | "responses" | "revenueByCurrency">>,
  revenueByCurrency: ReadonlyArray<{ currency: CurrencyCode; minor: number }>,
  ordersByCurrency: ReadonlyArray<{ currency: CurrencyCode; count: number }> = [],
): { channel: string; byRevenue: boolean; currency: CurrencyCode | null; minor: number | null } | null {
  if (channels.length === 0) return null;

  const ordersIn = (currency: CurrencyCode) => ordersByCurrency.find((e) => e.currency === currency)?.count ?? 0;
  const main = revenueByCurrency.reduce<{ currency: CurrencyCode; minor: number } | undefined>(
    (best, entry) =>
      !best ||
      ordersIn(entry.currency) > ordersIn(best.currency) ||
      (ordersIn(entry.currency) === ordersIn(best.currency) && entry.currency < best.currency)
        ? entry
        : best,
    undefined,
  );

  if (main && main.minor > 0) {
    let best: { channel: string; minor: number; responses: number } | undefined;
    for (const channel of channels) {
      const minor = channel.revenueByCurrency.find((e) => e.currency === main.currency)?.minor ?? 0;
      if (!best || minor > best.minor || (minor === best.minor && channel.responses > best.responses)) {
        best = { channel: channel.channel, minor, responses: channel.responses };
      }
    }
    if (best && best.minor > 0) {
      return { channel: best.channel, byRevenue: true, currency: main.currency, minor: best.minor };
    }
  }

  const busiest = channels.reduce((best, c) => (c.responses > best.responses ? c : best));
  return { channel: busiest.channel, byRevenue: false, currency: null, minor: null };
}
