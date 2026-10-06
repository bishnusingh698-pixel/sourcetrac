import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Banner, Metric, MoneyList, Panel, type BadgeTone } from "~/components/admin-ui";
import { buildTrend, computeStats } from "~/lib/analytics";
import { fetchDashboardData } from "~/lib/analytics-queries.server";
import { formatMoney } from "~/lib/money";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Dashboard.
 *
 * One primary action: "Edit question" (Settings). Everything else is read-only
 * reporting, so there is no competing call to action.
 *
 * All money is formatted here on the server and shipped as strings. The browser
 * never receives minor-unit integers, so it cannot sum across currencies by
 * accident.
 */

export const meta: MetaFunction = () => [{ title: "Dashboard — SourceTrac" }];

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

function parseRange(value: string | null): (typeof RANGES)[number] {
  const match = RANGES.find((r) => String(r.days) === value);
  return match ?? RANGES[1];
}

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);


  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get("range"));

  const data = await fetchDashboardData({ shopId: shop.id, days: range.days });
  const { summary, channels } = computeStats({
    responses: data.responses,
    decidedAmounts: data.decidedAmounts,
    ordersInWindow: data.ordersInWindow,
    previousResponsesCount: data.previousCount,
  });
  const trend = buildTrend({
    responses: data.responses,
    decidedAmounts: data.decidedAmounts,
    days: range.days,
  });

  return {
    range,
    hasAnyResponse: summary.totalResponses > 0,
    ordersInWindow: data.ordersInWindow,
    summary: {
      totalResponses: summary.totalResponses,
      lockedResponses: summary.lockedResponses,
      pendingResponses: summary.pendingResponses,
      responseRate: summary.responseRate,
      responseRateChange: summary.responseRateChange,
      revenue: summary.revenueByCurrency.map((entry) => ({
        currency: entry.currency,
        text: formatMoney(entry.minor, entry.currency),
      })),
      aov: summary.aovByCurrency.map((entry) => ({
        currency: entry.currency,
        text: formatMoney(entry.minor, entry.currency),
      })),
    },
    channels: channels.map((channel) => ({
      channel: channel.channel,
      responses: channel.responses,
      lockedResponses: channel.lockedResponses,
      pendingResponses: channel.pendingResponses,
      revenue: channel.revenueByCurrency.map((entry) => ({
        currency: entry.currency,
        text: formatMoney(entry.minor, entry.currency),
      })),
      aov: channel.aovByCurrency.map((entry) => ({
        currency: entry.currency,
        text: formatMoney(entry.minor, entry.currency),
      })),
    })),
    trend: trend.map((point) => ({
      date: point.date,
      responses: point.responses,
    })),
  };
});

/**
 * `YYYY-MM-DD` -> `4 Oct`.
 *
 * Built from the string parts rather than `new Date("2026-10-04")`, which parses
 * as UTC midnight and then renders as the *previous* day for any negative UTC
 * offset. Splitting the string keeps the label on the intended calendar day
 * regardless of where the merchant or the browser is.
 */
function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;

  const monthName = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
  return `${day} ${monthName}`;
}

/** `+12.4%` / `-3.0%`, plus the tone that matches the direction. */
function formatDelta(change: number | null): { text: string; tone: BadgeTone } | null {
  // A null change means the previous period had no orders, not "no change".
  // Showing `0%` there would be a fabricated measurement.
  if (change === null) return null;

  return {
    text: `${change > 0 ? "↑" : change < 0 ? "↓" : ""} ${Math.abs(change).toFixed(1)}%`,
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
function Sparkline({ points }: { points: Array<{ date: string; responses: number }> }) {
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
          <s-text type="strong">Not enough data to chart yet</s-text>
          <s-text color="subdued" fontSize="small">
            Once a couple of days have answers, the trend appears here.
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
      <s-box>
        <svg
          viewBox="0 0 100 40"
          width="100%"
          height="160"
          role="img"
          aria-label={`Responses per day. ${total} responses across ${activeDays} days, peaking at ${peak.responses} on ${peak.date}.`}
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

          {/* A dot on the latest day anchors the eye to "now". */}
          <circle
            cx={xAt(points.length - 1)}
            cy={yAt(points.at(-1)?.responses ?? 0)}
            r="1.6"
            fill="currentColor"
          />
        </svg>
      </s-box>

      <s-stack direction="block" gap="small">
        <s-divider />
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="small">
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              Answers
            </s-text>
            <s-text type="strong" fontVariantNumeric="tabular-nums">
              {total}
            </s-text>
          </s-stack>
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              Best day
            </s-text>
            <s-text type="strong" fontVariantNumeric="tabular-nums">
              {peak.responses}
              <s-text color="subdued" fontSize="small">
                {" "}
                on {formatDayLabel(peak.date)}
              </s-text>
            </s-text>
          </s-stack>
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              Days with answers
            </s-text>
            <s-text type="strong" fontVariantNumeric="tabular-nums">
              {activeDays} of {points.length}
            </s-text>
          </s-stack>
        </s-grid>
      </s-stack>
    </s-stack>
  );
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  // Denominator for the per-channel share bars. Derived on the client from data
  // already in the payload, so it costs no extra query.
  const maxChannelResponses = Math.max(0, ...data.channels.map((c) => c.responses));

  return (
    <s-stack gap="base">
      <s-section
        heading="Dashboard"
        subheading="How buyers found you, and what each channel is worth."
        padding="none"
      />

      {/* Range switcher. A link rather than a select so the choice is in the URL
          and survives a refresh or a shared link. */}
      <s-button-group>
        {RANGES.map((range) => (
          <s-button
            key={range.days}
            href={`/app?range=${range.days}`}
            variant={range.days === data.range.days ? "primary" : "secondary"}
          >
            {range.label}
          </s-button>
        ))}
      </s-button-group>

      {data.hasAnyResponse ? (
        <>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <Metric label="Responses" help={`Last ${data.range.label}`}>
              {data.summary.totalResponses}
            </Metric>

            <Metric
              label="Revenue attributed"
              help="Matched to real orders, by currency"
            >
              <MoneyList amounts={data.summary.revenue} />
            </Metric>

            <Metric label="Average order value" help="Revenue divided by matched orders">
              <MoneyList amounts={data.summary.aov} />
            </Metric>

            <Metric
              label="Response rate"
              trend={formatDelta(data.summary.responseRateChange)}
              help={
                data.summary.responseRate === null
                  ? "No orders in this period yet"
                  : `${data.summary.responseRate.toFixed(1)}% of ${data.ordersInWindow} orders`
              }
            >
              {/* null is rendered as an em dash, never 0% or NaN — a divide by
                  zero orders is "unknown", not "nobody answered". */}
              {data.summary.responseRate === null ? "—" : `${data.summary.responseRate.toFixed(1)}%`}
            </Metric>
          </s-grid>

          {data.summary.pendingResponses > 0 ? (
            <Banner tone="info" heading={`${data.summary.pendingResponses} answers are waiting for order details`}>
              These buyers answered before Shopify sent us the order. Revenue appears once the order
              arrives, usually within a minute. The answers themselves are already saved.
            </Banner>
          ) : null}

          {data.summary.lockedResponses > 0 ? (
            <Banner tone="warning" heading={`${data.summary.lockedResponses} answers came in after your plan limit`}>
              They are stored and already counted in the totals above. Upgrade to remove the limit.
            </Banner>
          ) : null}

          <Panel title="Responses over time" description={`Daily answers, last ${data.range.label}`}>
            <Sparkline points={data.trend.map((p) => ({ date: p.date, responses: p.responses }))} />
          </Panel>

          <Panel title="By channel" description="Answers and the revenue they map to.">
            <s-table>
              <s-table-header>
                <s-table-header-row>
                  <s-table-cell>Channel</s-table-cell>
                  <s-table-cell>Share</s-table-cell>
                  <s-table-cell>Responses</s-table-cell>
                  <s-table-cell>Revenue</s-table-cell>
                  <s-table-cell>Average order</s-table-cell>
                </s-table-header-row>
              </s-table-header>
              <s-table-body>
                {data.channels.map((channel) => {
                  // Share of responses, so the biggest channel is obvious without
                  // reading every number. Uses the largest channel as the
                  // denominator: comparing every bar to 100% would make a flat
                  // distribution look like a set of unrelated slivers.
                  const share =
                    maxChannelResponses > 0 ? (channel.responses / maxChannelResponses) * 100 : 0;

                  return (
                    <s-table-row key={channel.channel}>
                      <s-table-cell>
                        <s-stack gap="small-200">
                          <s-text type="strong">{channel.channel}</s-text>
                          {channel.pendingResponses > 0 ? (
                            <s-badge tone="info">
                              {channel.pendingResponses} pending
                            </s-badge>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        {/* `s-progress` is styled by the theme, so this bar tracks
                            the merchant's admin colours rather than a fixed hue. */}
                        <s-progress
                          value={Math.round(share)}
                          max={100}
                          tone="info"
                          accessibilityLabel={`${channel.channel}: ${Math.round(share)}% of the busiest channel`}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-text fontVariantNumeric="tabular-nums">{channel.responses}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {channel.revenue.length > 0 ? (
                          <MoneyList amounts={channel.revenue} />
                        ) : (
                          <s-text color="subdued">Waiting for order</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {channel.aov.length > 0 ? (
                          <MoneyList amounts={channel.aov} />
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </Panel>
        </>
      ) : (
        <s-empty-state heading="No answers yet">
          <s-stack gap="base">
            <s-text>
              Once buyers answer your question on the thank-you page, their answers and the value of
              the orders they placed will show up here.
            </s-text>
            <s-button href="/app/onboarding" variant="primary">
              Get started
            </s-button>
          </s-stack>
        </s-empty-state>
      )}
    </s-stack>
  );
}