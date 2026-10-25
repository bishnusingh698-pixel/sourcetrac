import { buildTrend, computeStats, pickTopChannel } from "~/lib/analytics";
import { decideRevenue, fetchChannelLabels, fetchDashboardData } from "~/lib/analytics-queries.server";
import { formatMoney } from "~/lib/money";
import { effectivePlan, PLAN_FREE } from "~/lib/plans";
import { OTHER_CHANNEL_VALUE } from "~/lib/settings";

/**
 * The channel report's numbers, as both the channel report and the Dashboard
 * render them.
 *
 * One loader for both screens, so the headline numbers on the Dashboard can
 * never disagree with the full report a click away. All money is formatted here on
 * the server and shipped as strings: the browser never receives minor-unit
 * integers, so it cannot sum across currencies by accident.
 */

type ReportShop = Parameters<typeof fetchChannelLabels>[0] & {
  id: string;
  plan: unknown;
  planStatus: string;
};

export type Money = { currency: string; text: string };

/** Written-in answers listed on the channel report. */
const OTHER_ANSWER_LIMIT = 20;

export async function loadChannelReport(params: {
  shop: ReportShop;
  days: number;
  locale: string;
  now?: Date;
  /** The store's IANA zone: range edges and trend days are its calendar days. */
  timeZone?: string | null;
}) {
  const { shop, days, locale, timeZone } = params;
  const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);

  // Responses store the channel slug (`friend-or-family`). Show the
  // merchant's own label for it. A slug no longer in the survey (the option
  // was deleted) has no label left, so the slug itself is the best name.
  const labels = await fetchChannelLabels(shop);

  // One clock for the window and the trend, so they cannot straddle midnight.
  const now = params.now ?? new Date();
  const data = await fetchDashboardData({ shopId: shop.id, days, now, timeZone });
  const { summary, channels } = computeStats({
    responses: data.responses,
    decidedAmounts: data.decidedAmounts,
    ordersInWindow: data.ordersInWindow,
    rateResponses: data.rateResponses,
    previousResponsesCount: data.previousCount,
  });
  const trend = buildTrend({ responses: data.responses, decidedAmounts: data.decidedAmounts, days, now, timeZone });

  // null for "other": translated in the component, not here.
  const labelFor = (channel: string) =>
    channel === OTHER_CHANNEL_VALUE ? null : (labels.get(channel) ?? channel);

  const top = pickTopChannel(channels, summary.revenueByCurrency, summary.revenueOrdersByCurrency);
  const topStat = top ? channels.find((c) => c.channel === top.channel) : undefined;

  return {
    // Any answer ever, not just in this window: an established shop with a
    // quiet month is not shown the brand-new "no answers yet" state.
    hasAnyResponse: data.anyAnswer,
    ordersInWindow: data.ordersInWindow,
    summary: {
      totalResponses: summary.totalResponses,
      // Only a Free shop is shown the over-cap prompt. `isLocked` is never
      // cleared, so after an upgrade the banner kept telling a paying merchant
      // to upgrade.
      lockedResponses: effectivePlan(shop) === PLAN_FREE ? summary.lockedResponses : 0,
      pendingResponses: summary.pendingResponses,
      // Answers on Shopify test orders (every order on a development store).
      // Their revenue is excluded by policy, which left a test store showing
      // answers with no revenue and no explanation.
      testOrderResponses: data.responses.filter((row) => {
        const decision = decideRevenue(row);
        return !decision.included && decision.reason === "test_order";
      }).length,
      responseRate: summary.responseRate,
      rateResponses: summary.rateResponses,
      responseRateChange: summary.responseRateChange,
      revenue: summary.revenueByCurrency.map((entry) => ({
        currency: entry.currency,
        text: money(entry.minor, entry.currency),
      })),
      aov: summary.aovByCurrency.map((entry) => ({
        currency: entry.currency,
        text: money(entry.minor, entry.currency),
      })),
    },
    topChannel:
      top && topStat
        ? {
            channel: top.channel,
            label: labelFor(top.channel),
            byRevenue: top.byRevenue,
            revenue: top.minor !== null && top.currency ? money(top.minor, top.currency) : null,
            responses: topStat.responses,
            // Share of all answers in the window, as a whole percent.
            sharePercent:
              summary.totalResponses > 0 ? Math.round((topStat.responses / summary.totalResponses) * 100) : 0,
          }
        : null,
    channels: channels.map((channel) => ({
      channel: channel.channel,
      label: labelFor(channel.channel),
      responses: channel.responses,
      lockedResponses: channel.lockedResponses,
      pendingResponses: channel.pendingResponses,
      revenue: channel.revenueByCurrency.map((entry) => ({
        currency: entry.currency,
        text: money(entry.minor, entry.currency),
      })),
      aov: channel.aovByCurrency.map((entry) => ({
        currency: entry.currency,
        text: money(entry.minor, entry.currency),
      })),
    })),
    trend: trend.map((point) => ({ date: point.date, responses: point.responses })),
    /**
     * What buyers typed when none of the listed channels fit, newest first.
     * These are where a merchant spots a channel they did not know they had.
     * Trimmed and capped; the Responses page and the CSV have every one.
     */
    otherAnswers: data.responses
      .flatMap((row) => {
        const text = row.otherText?.trim() ?? "";
        return text ? [{ id: row.id, text, label: labelFor(row.channel), submittedAt: row.submittedAt.toISOString() }] : [];
      })
      .slice(0, OTHER_ANSWER_LIMIT),
  };
}

export type ChannelReport = Awaited<ReturnType<typeof loadChannelReport>>;
