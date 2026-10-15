import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";

import { Panel } from "~/components/admin-ui";
import {
  ChannelTable,
  KpiGrid,
  ReportNotes,
  Sparkline,
  TopChannelCallout,
} from "~/components/channel-report";
import { loadChannelReport } from "~/lib/channel-report.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { maybeMarkUnreconcilable } from "~/lib/responses.server";
import { maybeRunPendingSync } from "~/lib/sync.server";
import { maybeRunPendingDeletions } from "~/lib/compliance.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Channel report — which channels bring buyers, and what they are worth.
 *
 * Read top to bottom: the best channel in one sentence, the four headline
 * numbers, one note explaining anything that is not counted yet, the full
 * table, then the trend. Range is a link so it survives a refresh.
 *
 * The data is built by `loadChannelReport`, which Home shares, so the numbers
 * on both screens always agree.
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
  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));
  const report = await loadChannelReport({ shop, days: range.days, locale });

  return { range, ...report };
});

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const { t, locale } = useAdminI18n();
  const rangeLabel = t(data.range.labelKey);

  return (
    <s-stack gap="base">
      {/* What the page answers, and the range switcher on the same row on
          desktop; stacked on a phone. */}
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 640px) minmax(0, 1fr) auto, minmax(0, 1fr)"
          gap="small"
          alignItems="center"
        >
          <s-text color="subdued">{t("dashboard.subtitle")}</s-text>
          {/* An inline stack, not a button group: a group never wraps, and the
              three ranges in French or German are wider than a phone. The
              plain div keeps the group role and its label for screen readers. */}
          <div role="group" aria-label={t("dashboard.range_label")}>
          <s-stack direction="inline" gap="small-200">
            {RANGES.map((range) => (
              <s-button
                key={range.days}
                href={`/app/dashboard?range=${range.days}`}
                variant={range.days === data.range.days ? "primary" : "secondary"}
              >
                {t(range.labelKey)}
              </s-button>
            ))}
          </s-stack>
          </div>
        </s-grid>
      </s-query-container>

      {data.hasAnyResponse ? (
        <>
          <TopChannelCallout report={data} t={t} rangeLabel={rangeLabel} />

          <KpiGrid report={data} t={t} locale={locale} rangeLabel={rangeLabel} />

          <ReportNotes summary={data.summary} t={t} />

          <Panel title={t("dashboard.channels_title")} description={t("dashboard.channels_subtitle")}>
            {data.channels.length === 0 ? (
              <s-text color="subdued">{t("dashboard.no_answers_in_range", { range: rangeLabel })}</s-text>
            ) : (
              <ChannelTable channels={data.channels} t={t} locale={locale} />
            )}
          </Panel>

          <Panel title={t("dashboard.trend_title")} description={t("dashboard.trend_subtitle", { range: rangeLabel })}>
            <Sparkline points={data.trend} t={t} locale={locale} />
          </Panel>
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
