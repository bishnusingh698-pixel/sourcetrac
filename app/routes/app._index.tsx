import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Banner, Metric, MoneyList, Panel } from "~/components/admin-ui";
import { buildTrend, computeStats } from "~/lib/analytics";
import { fetchDashboardData } from "~/lib/analytics-queries.server";
import { formatMoney } from "~/lib/money";
import { findShopByDomain } from "~/lib/shop.server";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findShopByDomain(session.shop);

  // A shop row is written at install time. Absent here means the callback was
  // bypassed, so rather than crash we send them back through OAuth.
  if (!shop) throw new Response(null, { status: 302, headers: { Location: "/auth?redirect=/app" } });

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
};

function Sparkline({ points }: { points: Array<{ date: string; responses: number }> }) {
  const max = Math.max(1, ...points.map((p) => p.responses));
  // A polyline needs two points to have a direction; a single point would
  // otherwise render as an invisible dot.
  const canDrawLine = points.length >= 2;
  // Readable inline SVG rather than a charting dependency: the shape is a
  // simple polyline and this keeps the admin bundle small.
  const pointsAttr = points
    .map((p, i) => `${(i / Math.max(1, points.length - 1)) * 100},${40 - (p.responses / max) * 40}`)
    .join(" ");

  return (
    <svg viewBox="0 0 100 40" width="100%" height="120" role="img" aria-label="Responses per day">
      {canDrawLine ? (
        <text x="50" y="22" textAnchor="middle" fontSize="4" fill="currentColor">
          Not enough data yet
        </text>
      ) : (
        <polyline
          points={pointsAttr}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

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
            <Banner tone="warning" heading={`${data.summary.lockedResponses} answers are paused by your plan limit`}>
              They are stored and will appear in your totals as soon as you upgrade. Nothing is lost.
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
                  <s-table-cell>Responses</s-table-cell>
                  <s-table-cell>Revenue</s-table-cell>
                  <s-table-cell>Average order</s-table-cell>
                </s-table-header-row>
              </s-table-header>
              <s-table-body>
                {data.channels.map((channel) => (
                  <s-table-row key={channel.channel}>
                    <s-table-cell>
                      <s-text type="strong">{channel.channel}</s-text>
                    </s-table-cell>
                    <s-table-cell>{channel.responses}</s-table-cell>
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
                ))}
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