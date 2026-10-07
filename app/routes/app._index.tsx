import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { OTHER_CHANNEL_VALUE, parseSurveySettings } from "~/lib/settings";

import { Banner, Metric, MoneyList, Panel, type BadgeTone } from "~/components/admin-ui";
import { LanguageForm } from "~/components/language-selector";
import { db } from "~/db.server";
import { isSupportedLanguage, type LanguageCode } from "~/lib/i18n";
import { MAX_OPTIONS, MIN_OPTIONS } from "~/lib/settings";
import { buildTrend, computeStats } from "~/lib/analytics";
import { fetchDashboardData } from "~/lib/analytics-queries.server";
import { formatMoney } from "~/lib/money";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Dashboard — the app's home page.
 *
 * Until the first answer arrives this page is the setup guide (it used to be a
 * separate "Get started" page, which meant a new merchant landed on an empty
 * dashboard and had to find the checklist themselves). Once answers exist it
 * is read-only reporting with one action, "Edit survey".
 *
 * All money is formatted here on the server and shipped as strings. The browser
 * never receives minor-unit integers, so it cannot sum across currencies by
 * accident.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "dashboard.title");

/** `labelKey` is resolved per render; see the NAV comment in `app.tsx`. */
const RANGES = [
  { days: 7, labelKey: "dashboard.last_7" },
  { days: 30, labelKey: "dashboard.last_30" },
  { days: 90, labelKey: "dashboard.last_90" },
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

  // Money is formatted here, so the loader needs the language itself: the
  // shell's loader runs in parallel and its data is not available yet.
  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language));
  const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);

  // Responses store the channel slug (`friend-or-family`). Show the
  // merchant's own label for it. A slug no longer in the survey (the option
  // was deleted) has no label left, so the slug itself is the best name.
  const labels = new Map(
    parseSurveySettings(shop.optionsJson, { questionText: shop.questionText, options: [], allowOther: false })
      .options.map((option) => [option.value, option.label] as const),
  );

  const [data, firstResponse, firstOrder] = await Promise.all([
    fetchDashboardData({ shopId: shop.id, days: range.days }),
    // Ever, not in the window: a quiet week must not send an established
    // merchant back to the setup guide.
    db.surveyResponse.findFirst({ where: { shopId: shop.id }, select: { id: true } }),
    db.orderCache.findFirst({ where: { shopId: shop.id }, select: { id: true } }),
  ]);
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
    setup:
      firstResponse === null
        ? {
            shopHandle: shop.shopDomain.replace(/\.myshopify\.com$/, ""),
            hasOrders: firstOrder !== null,
            hasOther: shop.allowOther,
            // False until the merchant picks a language themselves; while it is
            // false the full picker is offered as the first setup step.
            hasExplicitLanguage: isSupportedLanguage(shop.language),
          }
        : null,
    ordersInWindow: data.ordersInWindow,
    summary: {
      totalResponses: summary.totalResponses,
      lockedResponses: summary.lockedResponses,
      pendingResponses: summary.pendingResponses,
      responseRate: summary.responseRate,
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
    channels: channels.map((channel) => ({
      channel: channel.channel,
      // null for "other": translated in the component, not here.
      label: channel.channel === OTHER_CHANNEL_VALUE ? null : (labels.get(channel.channel) ?? channel.channel),
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
function formatDayLabel(dateKey: string, locale: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;

  // Formatted at UTC from a UTC date, so the calendar day cannot shift. The
  // locale decides the order and spelling ("4 Oct", "Oct 4", "10月4日").
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** `12.5%` in the merchant's locale (`12,5 %` in French). */
function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}

/** `+12.4%` / `-3.0%`, plus the tone that matches the direction. */
function formatDelta(change: number | null, t: TFunction, locale: string): { text: string; tone: BadgeTone } | null {
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
function Sparkline({
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
      <s-box padding="none">
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
      </s-box>

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
              <s-text color="subdued" fontSize="small">
                {" "}
                {t("dashboard.trend_stat_peak_on", { date: formatDayLabel(peak.date, locale) })}
              </s-text>
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

type Setup = {
  shopHandle: string;
  hasOrders: boolean;
  hasOther: boolean;
  hasExplicitLanguage: boolean;
};

/**
 * First-run checklist, shown on the dashboard until the first answer arrives.
 *
 * A step is only reported as done when we can prove it from our own data. Step
 * 1 is never ticked: the Admin API exposes no "block enabled" state and Shopify
 * sends no event when a checkout block is toggled, so guessing would be worse
 * than asking the merchant to confirm.
 */
function SetupGuide({ setup, t, language }: { setup: Setup; t: TFunction; language: LanguageCode }) {
  // Thank-you and order-status blocks only exist in the *checkout* editor
  // (Settings › Checkout › Customize), never the Online Store theme editor.
  const editorUrl = `https://admin.shopify.com/store/${setup.shopHandle}/settings/checkout/editor?page=thank-you`;

  const steps: Array<{ title: string; body: string; action?: { label: string; href: string } }> = [
    {
      title: t("onboarding.step1_title"),
      body: setup.hasOrders ? t("onboarding.step1_body_orders") : t("onboarding.step1_body"),
      action: { label: t("onboarding.step1_action"), href: editorUrl },
    },
    {
      title: t("onboarding.step2_title"),
      body: setup.hasOther
        ? t("onboarding.step2_body_other")
        : t("onboarding.step2_body", { min: MIN_OPTIONS, max: MAX_OPTIONS }),
      action: { label: t("onboarding.step2_action"), href: "/app/settings" },
    },
    {
      title: t("onboarding.step3_title"),
      body: t("onboarding.step3_body"),
    },
  ];

  return (
    <s-stack gap="base">
      {setup.hasExplicitLanguage ? null : (
        <Panel title={t("onboarding.language_step_title")}>
          <s-stack gap="base">
            <s-text color="subdued">{t("onboarding.language_step_body")}</s-text>
            {/* The full grid, not the toolbar's dropdown: a first-time visitor
                who cannot read the current language cannot operate a dropdown
                they cannot read either. */}
            <LanguageForm language={language} detected />
          </s-stack>
        </Panel>
      )}

      <s-section heading={t("onboarding.title")}>
        <s-stack gap="base">
          <s-text color="subdued">{t("onboarding.subtitle")}</s-text>
          <s-progress
            value={0}
            max={steps.length}
            accessibilityLabel={t("onboarding.progress_aria", { done: 0, total: steps.length })}
          />
          {steps.map((step, index) => (
            <s-box key={step.title} padding="base" border="base" borderRadius="base">
              <s-stack gap="small">
                <s-text type="strong">
                  {index + 1}. {step.title}
                </s-text>
                <s-text color="subdued">{step.body}</s-text>
                {step.action ? (
                  <div>
                    {/* Shopify admin pages refuse to render inside the app's
                        iframe, so the checkout editor opens in the top window.
                        In-app links stay in the frame. */}
                    <s-button
                      href={step.action.href}
                      target={step.action.href.startsWith("https://") ? "_top" : "auto"}
                      variant={index === 0 ? "primary" : "secondary"}
                    >
                      {step.action.label}
                    </s-button>
                  </div>
                ) : null}
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <Banner tone="info" heading={t("onboarding.why_title")}>
        <s-text>{t("onboarding.why_body")}</s-text>
      </Banner>
    </s-stack>
  );
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const { t, locale, language } = useAdminI18n();
  const rangeLabel = t(data.range.labelKey);
  const pending = data.summary.pendingResponses;
  const locked = data.summary.lockedResponses;

  // Denominator for the per-channel share bars. Derived on the client from data
  // already in the payload, so it costs no extra query.
  const maxChannelResponses = Math.max(0, ...data.channels.map((c) => c.responses));

  if (data.setup) return <SetupGuide setup={data.setup} t={t} language={language} />;

  return (
    <s-stack gap="base">
      {/* Title and range switcher share a row on desktop and stack on a phone.
          The range is a link rather than a select so the choice is in the URL
          and survives a refresh or a shared link. */}
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 640px) 1fr auto, 1fr"
          gap="small"
          alignItems="center"
        >
          <s-stack gap="small-200">
            <s-heading>{t("dashboard.title")}</s-heading>
            <s-text color="subdued">{t("dashboard.subtitle")}</s-text>
          </s-stack>
          <s-button-group accessibilityLabel={t("dashboard.range_label")}>
            {RANGES.map((range) => (
              <s-button
                key={range.days}
                href={`/app?range=${range.days}`}
                variant={range.days === data.range.days ? "primary" : "secondary"}
              >
                {t(range.labelKey)}
              </s-button>
            ))}
          </s-button-group>
        </s-grid>
      </s-query-container>

      {data.hasAnyResponse ? (
        <>
          {/* Two tiles per row on a phone, four on desktop. A single column
              made the four headline numbers a long scroll on a phone. */}
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size > 760px) repeat(4, minmax(0, 1fr)), (inline-size > 300px) repeat(2, minmax(0, 1fr)), minmax(0, 1fr)"
              gap="small"
            >
              <Metric label={t("dashboard.metric_responses")} help={rangeLabel}>
                {data.summary.totalResponses}
              </Metric>

              <Metric label={t("dashboard.metric_revenue")} help={t("dashboard.metric_revenue_help")}>
                <MoneyList amounts={data.summary.revenue} />
              </Metric>

              <Metric label={t("dashboard.metric_aov")} help={t("dashboard.metric_aov_help")}>
                <MoneyList amounts={data.summary.aov} />
              </Metric>

              <Metric
                label={t("dashboard.metric_response_rate")}
                trend={formatDelta(data.summary.responseRateChange, t, locale)}
                help={
                  data.summary.responseRate === null
                    ? t("dashboard.response_rate_no_orders")
                    : t("dashboard.response_rate_of_orders", {
                        count: data.summary.totalResponses,
                        total: data.ordersInWindow,
                      })
                }
              >
                {/* null is rendered as an em dash, never 0% or NaN — a divide by
                    zero orders is "unknown", not "nobody answered". */}
                {data.summary.responseRate === null ? "—" : formatPercent(data.summary.responseRate, locale)}
              </Metric>
            </s-grid>
          </s-query-container>

          {pending > 0 ? (
            <Banner tone="info" heading={t("dashboard.pending_banner_title", { count: pending })}>
              {t("dashboard.pending_banner_body")}
            </Banner>
          ) : null}

          {locked > 0 ? (
            <Banner tone="warning" heading={t("dashboard.locked_banner_title", { count: locked })}>
              {t("dashboard.locked_banner_body")}
            </Banner>
          ) : null}

          <Panel title={t("dashboard.channels_title")} description={t("dashboard.channels_subtitle")}>
            {/* Real column headers (`s-table-header`) with list slots, so on a
                narrow screen Polaris re-lays each row as a card — channel name
                on top, the numbers as labelled pairs — instead of a five-column
                table scrolling sideways on a phone. */}
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
                {data.channels.map((channel) => {
                  // Share of responses relative to the busiest channel, so a
                  // flat distribution reads as comparable bars rather than
                  // unrelated slivers of 100%.
                  const share =
                    maxChannelResponses > 0 ? (channel.responses / maxChannelResponses) * 100 : 0;
                  const name = channel.label ?? t("dashboard.channel_other");

                  return (
                    <s-table-row key={channel.channel}>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-200" alignItems="center">
                          <s-text type="strong">{name}</s-text>
                          {channel.pendingResponses > 0 ? (
                            <s-badge tone="info">
                              {t("dashboard.pending_badge", { count: channel.pendingResponses })}
                            </s-badge>
                          ) : null}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text fontVariantNumeric="tabular-nums">{channel.responses}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {/* `s-progress` is styled by the theme, so this bar tracks
                            the merchant's admin colours rather than a fixed hue. */}
                        <s-progress
                          value={Math.round(share)}
                          max={100}
                          tone="info"
                          accessibilityLabel={t("dashboard.share_aria", { channel: name, share: Math.round(share) })}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        {channel.revenue.length > 0 ? (
                          <MoneyList amounts={channel.revenue} />
                        ) : (
                          <s-text color="subdued">{t("dashboard.waiting_for_order")}</s-text>
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

          <Panel title={t("dashboard.trend_title")} description={t("dashboard.trend_subtitle", { range: rangeLabel })}>
            <Sparkline
              points={data.trend.map((p) => ({ date: p.date, responses: p.responses }))}
              t={t}
              locale={locale}
            />
          </Panel>

          <div>
            <s-button href="/app/settings" variant="secondary" icon="edit">
              {t("dashboard.edit_survey")}
            </s-button>
          </div>
        </>
      ) : (
        <s-section>
          <s-stack gap="base">
            <s-heading>{t("dashboard.empty_title")}</s-heading>
            <s-text>{t("dashboard.empty_body")}</s-text>
            <div>
              <s-button href="/app/settings" variant="secondary">
                {t("dashboard.edit_survey")}
              </s-button>
            </div>
          </s-stack>
        </s-section>
      )}
    </s-stack>
  );
}
