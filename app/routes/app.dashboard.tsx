import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { resolveAdminLanguage, resolveFormatLocale } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";

import { Panel, PageIntro, RangeSwitcher } from "~/components/admin-ui";
import { ChannelTable, OtherAnswers, ReportNotes, TopChannelCallout, formatPercent } from "~/components/channel-report";
import { loadChannelReport } from "~/lib/channel-report.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { maybeMarkUnreconcilable } from "~/lib/responses.server";
import { maybeRunPendingSync } from "~/lib/sync.server";
import { maybeRunPendingDeletions } from "~/lib/compliance.server";
import { guarded } from "~/lib/admin-errors.server";
import { getReportTimeZone } from "~/lib/studio.server";
import { authenticate } from "~/shopify.server";

/**
 * Channel report — which channels bring buyers, and what each one is worth.
 *
 * The Dashboard shows the headline numbers and the top five channels; this page
 * is the full attribution story behind them: the best channel in one sentence,
 * one note on anything not counted yet, every channel with its share, revenue
 * and average order (and a total row), the response rate, and what buyers wrote
 * when none of the listed channels fit. Range is a link so it survives a
 * refresh.
 *
 * The data is built by `loadChannelReport`, which the Dashboard shares, so the
 * numbers on both screens always agree.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "nav.channels");

export const handle = { titleKey: "nav.channels" };

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
  // Orders the webhooks never delivered (placed before install, for one) are
  // fetched in the background (never blocking this page), so their answers stop
  // reading "Pending" on the next load. Bounded and never throws.
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  // Retry any deferred Shopify write-back (Phase 7) and drain any redact that
  // was too large for the webhook budget (Phase 8). Throttled to once per few
  // minutes per process, and never throws, so neither can break the page.
  void maybeRunPendingSync(shop.id);
  // Age out answers whose order never arrived (hourly, process-wide). It used
  // to run only from the legacy extension's config route.
  void maybeMarkUnreconcilable();
  void maybeRunPendingDeletions(shop.id);


  const range = parseRange(new URL(request.url).searchParams.get("range"));
  // Money is formatted here, so the loader needs the language itself: the
  // shell's loader runs in parallel and its data is not available yet.
  const locale = resolveFormatLocale(request, resolveAdminLanguage(request, shop.language, shop.adminLocale), shop.adminLocale);
  const timeZone = await getReportTimeZone(shop.id, shop.shopDomain, session.accessToken);
  const report = await loadChannelReport({ shop, days: range.days, locale, timeZone });

  return { range, timeZone, ...report };
});

export default function ChannelReportPage() {
  const data = useLoaderData<typeof loader>();
  const { t, locale } = useAdminI18n();
  const rangeLabel = t(data.range.labelKey);
  const { summary } = data;

  return (
    <s-stack gap="base">
      <PageIntro
        actions={
          <RangeSwitcher
            label={t("dashboard.range_label")}
            options={RANGES.map((range) => ({
              key: String(range.days),
              label: t(range.labelKey),
              href: `/app/dashboard?range=${range.days}`,
              current: range.days === data.range.days,
            }))}
          />
        }
      >
        {t("dashboard.subtitle")}
      </PageIntro>

      {data.hasAnyResponse ? (
        <>
          <TopChannelCallout report={data} t={t} rangeLabel={rangeLabel} />

          <ReportNotes summary={summary} t={t} />

          <Panel title={t("dashboard.channels_title")} description={t("dashboard.channels_subtitle")}>
            {data.channels.length === 0 ? (
              <s-text color="subdued">{t("dashboard.no_answers_in_range", { range: rangeLabel })}</s-text>
            ) : (
              <s-stack gap="base">
                <ChannelTable channels={data.channels} t={t} locale={locale} totals={summary} />
                {/* The one number the table cannot show: how many orders
                    answered at all. null is "no orders yet", never 0%. */}
                <s-text color="subdued" fontSize="small">
                  {summary.responseRate === null
                    ? t("dashboard.response_rate_no_orders")
                    : t("dashboard.rate_line", {
                        rate: formatPercent(summary.responseRate, locale),
                        answered: summary.rateResponses,
                        total: data.ordersInWindow,
                      })}
                </s-text>
              </s-stack>
            )}
          </Panel>

          {data.otherAnswers.length > 0 ? (
            <Panel title={t("dashboard.other_title")} description={t("dashboard.other_subtitle")}>
              <OtherAnswers answers={data.otherAnswers} t={t} locale={locale} />
            </Panel>
          ) : null}
        </>
      ) : (
        <s-section heading={t("dashboard.empty_title")}>
          <s-stack gap="base">
            <s-text>{t("dashboard.empty_body")}</s-text>
            <div>
              <s-button href="/app" variant="primary">
                {t("dashboard.empty_cta")}
              </s-button>
            </div>
          </s-stack>
        </s-section>
      )}
    </s-stack>
  );
}
