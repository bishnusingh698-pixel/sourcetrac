import type { TFunction } from "~/lib/i18n";
import type { ChannelReport } from "~/lib/channel-report.server";

import { Banner, BigNumber, Metric, MoneyList, type BadgeTone } from "~/components/admin-ui";

/**
 * The channel report's building blocks, shared by the dashboard and Home so a
 * number looks the same on both. Pure presentation: everything arrives already
 * computed and formatted by `loadChannelReport`.
 *
 * Layout follows the usual dashboard order: the one insight that matters most,
 * then the headline numbers, then the breakdown, then the trend.
 */

/**
 * `YYYY-MM-DD` -> `4 Oct`.
 *
 * Built from the string parts rather than `new Date("2026-10-04")`, which parses
 * as UTC midnight and then renders as the *previous* day for any negative UTC
 * offset. Splitting the string keeps the label on the intended calendar day
 * regardless of where the merchant or the browser is.
 */
export function formatDayLabel(dateKey: string, locale: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;

  // Formatted at UTC from a UTC date, so the calendar day cannot shift. The
  // locale decides the order and spelling ("4 Oct", "Oct 4", "10月4日").
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** `12.5%` in the merchant's locale (`12,5 %` in French). */
export function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}

/** `+12.4%` / `-3.0%`, plus the tone that matches the direction. */
export function formatDelta(change: number | null, t: TFunction, locale: string): { text: string; tone: BadgeTone } | null {
  // A null change means the previous period had no orders, not "no change".
  // Showing `0%` there would be a fabricated measurement.
  if (change === null) return null;

  // The keys append their own `%`, so the number is passed without one.
  const value = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    Math.abs(change),
  );
  return {
    text:
      change > 0
        ? t("dashboard.delta_up", { value })
        : change < 0
          ? t("dashboard.delta_down", { value })
          : t("dashboard.delta_flat"),
    tone: change > 0 ? "success" : change < 0 ? "critical" : "neutral",
  };
}

/**
 * Responses-per-day sparkline.
 *
 * Hand-rolled inline SVG rather than a charting dependency: the shape is a
 * polyline and this keeps the admin bundle small.
 *
 * Everything is drawn with `currentColor` and `currentColor` at low opacity, so
 * the chart inherits whatever text colour the merchant's admin theme sets. No
 * hex, no `s-*` token, nothing that can drift from the surrounding page.
 */
export function Sparkline({
  points,
  t,
  locale,
}: {
  points: Array<{ date: string; responses: number }>;
  t: TFunction;
  locale: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.responses));
  const total = points.reduce((sum, p) => sum + p.responses, 0);
  const activeDays = points.filter((p) => p.responses > 0).length;
  // Reduce with an explicit `undefined` seed: `points[0]` is possibly-undefined
  // under noUncheckedIndexedAccess, and an empty array has no peak at all.
  const peak = points.reduce<{ date: string; responses: number } | undefined>(
    (best, p) => (!best || p.responses > best.responses ? p : best),
    undefined,
  );

  // A polyline needs two points to have a direction; a single point would
  // otherwise render as an invisible dot.
  if (points.length < 2 || !peak) {
    return (
      <s-box padding="large-400" background="subdued" borderRadius="base">
        <s-stack gap="small">
          <s-text type="strong">{t("dashboard.trend_empty_title")}</s-text>
          <s-text color="subdued" fontSize="small">
            {t("dashboard.trend_empty_body")}
          </s-text>
        </s-stack>
      </s-box>
    );
  }

  // The plot area stops short of the bottom so the filled area has somewhere to
  // go, and the top is inset so the peak never touches the edge.
  const TOP = 4;
  const BOTTOM = 32;
  const HEIGHT = BOTTOM - TOP;

  const xAt = (i: number) => (i / (points.length - 1)) * 100;
  const yAt = (value: number) => BOTTOM - (value / max) * HEIGHT;

  const linePoints = points.map((p, i) => `${xAt(i)},${yAt(p.responses)}`).join(" ");
  // Close the line down to the baseline to make a fillable area. Without the
  // two baseline corners the browser fills nothing.
  const areaPoints = `0,${BOTTOM} ${linePoints} 100,${BOTTOM}`;

  return (
    <s-stack gap="base">
      {/* Stretched to the panel's width (preserveAspectRatio="none"): the
          default letterboxed the chart into a narrow strip on wide screens and
          a tiny one on phones. Strokes are non-scaling, so the line weight
          never distorts. */}
      <div className="st-chart">
        <svg
          viewBox="0 0 100 40"
          width="100%"
          height="140"
          preserveAspectRatio="none"
          role="img"
          aria-label={t("dashboard.trend_aria", {
            total,
            days: activeDays,
            peak: peak.responses,
            date: formatDayLabel(peak.date, locale),
          })}
        >
          {/* Gridlines first so the line draws over them. */}
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              x1="0"
              x2="100"
              y1={BOTTOM - fraction * HEIGHT}
              y2={BOTTOM - fraction * HEIGHT}
              stroke="currentColor"
              strokeOpacity="0.1"
              strokeWidth="0.25"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <polygon points={areaPoints} fill="currentColor" fillOpacity="0.08" />

          <polyline
            points={linePoints}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* A dot on the latest day anchors the eye to "now". Drawn as a
              zero-length round-capped line rather than a <circle>: with a
              non-uniform aspect ratio a circle would stretch into an oval,
              while a non-scaling stroke stays round at any width. */}
          <line
            x1={xAt(points.length - 1)}
            x2={xAt(points.length - 1)}
            y1={yAt(points.at(-1)?.responses ?? 0)}
            y2={yAt(points.at(-1)?.responses ?? 0)}
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <s-stack direction="block" gap="small">
        <s-divider />
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 7rem), 1fr))" gap="small">
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              {t("dashboard.trend_stat_total")}
            </s-text>
            <s-text type="strong" fontVariantNumeric="tabular-nums">
              {total}
            </s-text>
          </s-stack>
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              {t("dashboard.trend_stat_peak")}
            </s-text>
            <s-text type="strong" fontVariantNumeric="tabular-nums">
              {peak.responses}
            </s-text>
            <s-text color="subdued" fontSize="small">
              {t("dashboard.trend_stat_peak_on", { date: formatDayLabel(peak.date, locale) })}
            </s-text>
          </s-stack>
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              {t("dashboard.trend_stat_active_days")}
            </s-text>
            <s-text type="strong" fontVariantNumeric="tabular-nums">
              {t("dashboard.trend_stat_active_days_value", { active: activeDays, total: points.length })}
            </s-text>
          </s-stack>
        </s-grid>
      </s-stack>
    </s-stack>
  );
}


/** A channel's display name: the merchant's label, or the translated "Other". */
export function channelName(label: string | null, t: TFunction): string {
  return label ?? t("dashboard.channel_other");
}

/**
 * The headline: which channel is working best, in one sentence.
 *
 * Revenue when there is some, answers otherwise. Shown in a success tone because
 * it is the good news a merchant opens the app for.
 */
export function TopChannelCallout({
  report,
  t,
  rangeLabel,
  action,
}: {
  report: Pick<ChannelReport, "topChannel" | "channels">;
  t: TFunction;
  rangeLabel: string;
  action?: { href: string; label: string };
}) {
  const top = report.topChannel;
  if (!top) return null;
  const name = channelName(top.label, t);

  return (
    <s-section>
      <s-query-container>
        <s-grid
          gridTemplateColumns={action ? "@container (inline-size > 560px) minmax(0, 1fr) auto, minmax(0, 1fr)" : "minmax(0, 1fr)"}
          gap="base"
          alignItems="center"
        >
          <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="base" alignItems="start">
            <s-box padding="small" borderRadius="large" background="subdued">
              <s-icon type="chart-popular" tone="success" />
            </s-box>
            <s-stack gap="small-200">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone="success">{t("dashboard.top_channel")}</s-badge>
                <s-text color="subdued" fontSize="small">
                  {rangeLabel}
                </s-text>
              </s-stack>
              <s-text fontSize="large" fontWeight="bold">
                {name}
              </s-text>
              <s-text>
                {top.byRevenue && top.revenue
                  ? t("dashboard.top_channel_revenue", {
                      count: top.responses,
                      revenue: top.revenue,
                      share: top.sharePercent,
                    })
                  : t("dashboard.top_channel_answers", { count: top.responses, share: top.sharePercent })}
              </s-text>
            </s-stack>
          </s-grid>
          {action ? (
            <s-button href={action.href} variant="secondary">
              {action.label}
            </s-button>
          ) : null}
        </s-grid>
      </s-query-container>
    </s-section>
  );
}

/**
 * The four headline numbers. Revenue is the one in colour: it is the number the
 * app exists to produce, so the eye should land on it first.
 */
export function KpiGrid({
  report,
  t,
  locale,
  rangeLabel,
  href,
}: {
  report: Pick<ChannelReport, "summary" | "ordersInWindow">;
  t: TFunction;
  locale: string;
  rangeLabel: string;
  /** Makes every tile a link, e.g. from Home to the full report. */
  href?: string;
}) {
  const { summary } = report;
  return (
    // Two tiles per row on a phone, four on desktop. A single column made the
    // four headline numbers a long scroll on a phone.
    <s-query-container>
      <s-grid
        gridTemplateColumns="@container (inline-size > 640px) repeat(4, minmax(0, 1fr)), repeat(2, minmax(0, 1fr))"
        gap="base"
      >
        <Metric label={t("dashboard.metric_revenue")} help={t("dashboard.metric_revenue_help")} href={href}>
          <MoneyList amounts={summary.revenue} size="large" tone="success" />
        </Metric>

        {/* The badge is the change in answer COUNT versus the previous period,
            so it sits on this tile. On the rate tile it read as a change in
            rate: orders and answers both doubling showed +100%. */}
        <Metric
          label={t("dashboard.metric_responses")}
          help={rangeLabel}
          trend={formatDelta(summary.responseRateChange, t, locale)}
          href={href}
        >
          <BigNumber>{summary.totalResponses}</BigNumber>
        </Metric>

        <Metric
          label={t("dashboard.metric_response_rate")}
          href={href}
          help={
            summary.responseRate === null
              ? t("dashboard.response_rate_no_orders")
              : t("dashboard.response_rate_of_orders", {
                  count: summary.rateResponses,
                  total: report.ordersInWindow,
                })
          }
        >
          {/* null is rendered as an em dash, never 0% or NaN — a divide by zero
              orders is "unknown", not "nobody answered". */}
          <BigNumber>{summary.responseRate === null ? "—" : formatPercent(summary.responseRate, locale)}</BigNumber>
        </Metric>

        <Metric label={t("dashboard.metric_aov")} help={t("dashboard.metric_aov_help")} href={href}>
          <MoneyList amounts={summary.aov} size="large" />
        </Metric>
      </s-grid>
    </s-query-container>
  );
}

/**
 * Why some numbers look low, in one banner rather than three stacked ones.
 *
 * Pending answers, test orders and over-limit answers each used to get their
 * own banner, which on a test store meant three boxes of text above the data.
 * The most actionable one sets the tone; each applicable reason is one line.
 */
export function ReportNotes({ summary, t }: { summary: ChannelReport["summary"]; t: TFunction }) {
  const lines: Array<{ key: string; text: string }> = [];
  if (summary.lockedResponses > 0) {
    lines.push({ key: "locked", text: t("dashboard.note_locked", { count: summary.lockedResponses }) });
  }
  if (summary.pendingResponses > 0) {
    lines.push({ key: "pending", text: t("dashboard.note_pending", { count: summary.pendingResponses }) });
  }
  if (summary.testOrderResponses > 0) {
    lines.push({ key: "test", text: t("dashboard.note_test_orders", { count: summary.testOrderResponses }) });
  }
  if (lines.length === 0) return null;

  return (
    <Banner tone={summary.lockedResponses > 0 ? "warning" : "info"} heading={t("dashboard.notes_title")}>
      <s-stack gap="small">
        {lines.map((line) => (
          <s-text key={line.key}>{line.text}</s-text>
        ))}
        {summary.lockedResponses > 0 ? (
          <div>
            <s-button href="/app/plans" variant="primary">
              {t("shell.cap_reached_cta")}
            </s-button>
          </div>
        ) : null}
      </s-stack>
    </Banner>
  );
}

/** The by-channel table. */
export function ChannelTable({
  channels,
  t,
  locale,
  limit,
}: {
  channels: ChannelReport["channels"];
  t: TFunction;
  locale: string;
  limit?: number;
}) {
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  // Denominator for the share bars: the busiest channel, so a flat
  // distribution reads as comparable bars rather than unrelated slivers.
  const maxChannelResponses = Math.max(0, ...channels.map((c) => c.responses));
  const total = channels.reduce((sum, c) => sum + c.responses, 0);
  const rows = limit ? channels.slice(0, limit) : channels;

  return (
    // Real column headers (`s-table-header`) with list slots, so on a narrow
    // screen Polaris re-lays each row as a card — channel name on top, the
    // numbers as labelled pairs — instead of a table scrolling sideways.
    <s-table variant="auto">
      <s-table-header-row>
        <s-table-header listSlot="primary">{t("dashboard.col_channel")}</s-table-header>
        <s-table-header listSlot="secondary" format="numeric">
          {t("dashboard.col_responses")}
        </s-table-header>
        <s-table-header listSlot="labeled">{t("dashboard.col_share")}</s-table-header>
        <s-table-header listSlot="labeled" format="currency">
          {t("dashboard.col_revenue")}
        </s-table-header>
        <s-table-header listSlot="labeled" format="currency">
          {t("dashboard.col_aov")}
        </s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((channel, index) => {
          const share = maxChannelResponses > 0 ? (channel.responses / maxChannelResponses) * 100 : 0;
          const ofTotal = total > 0 ? Math.round((channel.responses / total) * 100) : 0;
          const name = channelName(channel.label, t);

          return (
            <s-table-row key={channel.channel}>
              <s-table-cell>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text type="strong">{name}</s-text>
                  {index === 0 && channel.responses > 0 ? (
                    <s-badge tone="success">{t("dashboard.most_answers")}</s-badge>
                  ) : null}
                  {channel.pendingResponses > 0 ? (
                    <s-badge tone="info">{t("dashboard.pending_badge", { count: channel.pendingResponses })}</s-badge>
                  ) : null}
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                <s-text fontVariantNumeric="tabular-nums">{channel.responses}</s-text>
              </s-table-cell>
              <s-table-cell>
                <s-grid gridTemplateColumns="minmax(3rem, 1fr) auto" gap="small" alignItems="center">
                  {/* `s-progress` is styled by the theme, so this bar tracks
                      the merchant's admin colours rather than a fixed hue. */}
                  <s-progress
                    value={Math.round(share)}
                    max={100}
                    tone={index === 0 ? "success" : "info"}
                    accessibilityLabel={t("dashboard.share_aria", { channel: name, share: Math.round(share) })}
                  />
                  <s-text color="subdued" fontSize="small" fontVariantNumeric="tabular-nums">
                    {percent.format(ofTotal / 100)}
                  </s-text>
                </s-grid>
              </s-table-cell>
              <s-table-cell>
                {channel.revenue.length > 0 ? (
                  <MoneyList amounts={channel.revenue} />
                ) : channel.pendingResponses > 0 ? (
                  <s-text color="subdued">{t("dashboard.waiting_for_order")}</s-text>
                ) : (
                  // Every order arrived but none counts (test, cancelled or
                  // refunded). "Waiting for order" promised one that came.
                  <s-text color="subdued">—</s-text>
                )}
              </s-table-cell>
              <s-table-cell>
                {channel.aov.length > 0 ? <MoneyList amounts={channel.aov} /> : <s-text color="subdued">—</s-text>}
              </s-table-cell>
            </s-table-row>
          );
        })}
      </s-table-body>
    </s-table>
  );
}

export type { BadgeTone };
