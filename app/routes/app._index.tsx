import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { checkoutEditorUrl } from "~/lib/checkout-editor";
import { resolveAdminLanguage, resolveFormatLocale } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";

import { Panel, PageIntro, RangeSwitcher } from "~/components/admin-ui";
import { KpiGrid, ReportNotes, Sparkline } from "~/components/channel-report";
import { BuyerMix, ScoresSection, SurveysOverview, TopChannels } from "~/components/dashboard";
import { LanguageForm } from "~/components/language-selector";
import { db } from "~/db.server";
import { isSupportedLanguage, type LanguageCode } from "~/lib/i18n";
import { hasAnyResponse } from "~/lib/home.server";
import { getBlockSeen } from "~/lib/block-seen.server";
import { loadDashboard, type DashboardSurvey } from "~/lib/dashboard.server";
import { DASHBOARD_RANGE_LABEL_KEYS, DASHBOARD_RANGES, parseDashboardRange } from "~/lib/dashboard-range";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { maybeMarkUnreconcilable } from "~/lib/responses.server";
import { maybeRunPendingSync } from "~/lib/sync.server";
import { maybeRunPendingDeletions } from "~/lib/compliance.server";
import { guarded } from "~/lib/admin-errors.server";
import { templateById } from "@shared/templates/index";
import { templateText } from "@shared/templates/locales";
import { regionPackFor } from "@shared/templates/packs";
import { currentSpotlight } from "@shared/templates/catalog";
import { getShopLocaleInfo } from "~/lib/studio.server";
import { isValidTimeZone } from "@shared/zoned-date";
import { authenticate } from "~/shopify.server";

/**
 * Dashboard — the landing page, and the one screen with every important number.
 *
 * Top to bottom: the four attribution numbers (revenue, answers, response rate,
 * average order), customer scores (NPS and CSAT across every survey), the top
 * channels and new vs returning buyers, each survey's key result next to the
 * one suggested next step, and the daily trend. A range switcher covers all of
 * it. Each section links to the page with the full story, so this screen
 * summarises instead of repeating: the channel report has the full table and
 * buyers' own words, Results has every question.
 *
 * Until the first answer arrives this page is the setup guide instead.
 *
 * All money is formatted on the server and shipped as strings, so the browser
 * never sees minor-unit integers.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "nav.dashboard");

export const handle = { titleKey: "nav.home" };


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

  const locale = resolveFormatLocale(request, resolveAdminLanguage(request, shop.language, shop.adminLocale), shop.adminLocale);

  const [anyResponse, liveSurveys, blockSeen, localeInfo] = await Promise.all([
    // Ever, not in a window: a quiet week must not send an established
    // merchant back to the setup guide.
    hasAnyResponse(shop.id),
    db.survey.count({ where: { shopId: shop.id, status: "active" } }),
    getBlockSeen(shop.id),
    getShopLocaleInfo(shop.id, shop.shopDomain, session.accessToken),
  ]);
  // Days and ranges are the store's own calendar days.
  const timeZone = isValidTimeZone(localeInfo.timeZone) ? localeInfo.timeZone : "UTC";

  const days = parseDashboardRange(new URL(request.url).searchParams.get("range"));
  const dashboard = anyResponse ? await loadDashboard({ shop, days, locale, timeZone }) : null;
  const surveys = dashboard?.surveys ?? [];

  // The seasonal spotlight (T15) is the fallback next step when nothing more
  // urgent applies. Evaluated in the admin from the date and the shop's region:
  // no database, no network.
  const templateLocale = shop.language ?? "en";
  let spotlightTemplateName: string | null = null;
  if (surveys.length > 0) {
    const spotlight = currentSpotlight({
      locale: templateLocale,
      region: regionPackFor(localeInfo.countryCode),
      now: new Date(),
      timeZone,
    });
    spotlightTemplateName = spotlight
      ? templateText(templateLocale, templateById(spotlight.templateId)?.nameKey ?? "")
      : null;
  }

  return {
    setup:
      !anyResponse
        ? {
            shopHandle: shop.shopDomain.replace(/\.myshopify\.com$/, ""),
            hasLiveSurvey: liveSurveys > 0,
            // The setup guide is about the Thank-you page; Order status is an
            // optional extra the editor explains.
            blockSeen: blockSeen.thank_you,
            // False until the merchant picks a language themselves; while it is
            // false the full picker is offered as the first setup step.
            hasExplicitLanguage: isSupportedLanguage(shop.language),
          }
        : null,
    dashboard,
    spotlightTemplateName,
    // Template names live in the shared template bundle, not the admin i18n
    // bundle, so the fallback "Start with Channel Compass" name is resolved here.
    channelCompassName: templateText(templateLocale, "templates.channel-compass.name"),
  };
});

type Setup = {
  shopHandle: string;
  hasLiveSurvey: boolean;
  blockSeen: boolean;
  hasExplicitLanguage: boolean;
};

/**
 * First-run checklist, shown on Home until the first answer arrives.
 *
 * A step is only ticked when our own data proves it: a live survey, and the
 * block having asked us for a survey from the Thank-you page or the checkout
 * editor (`block-seen.server.ts`). Shopify reports no "block added" state, so
 * the block loading is the only proof there is.
 */
function SetupGuide({ setup, t, language }: { setup: Setup; t: TFunction; language: LanguageCode }) {
  const steps: Array<{ title: string; body: string; done: boolean; action?: { label: string; href: string } }> = [
    {
      title: t("onboarding.step1_title"),
      body: setup.hasLiveSurvey ? t("onboarding.step1_body_done") : t("onboarding.step1_body"),
      done: setup.hasLiveSurvey,
      // The quick start gets a first survey live in about two minutes; the
      // template library is one link away from it.
      action: setup.hasLiveSurvey ? undefined : { label: t("quick.cta"), href: "/app/surveys/quick-start" },
    },
    {
      title: t("onboarding.step2_title"),
      body: setup.blockSeen ? t("onboarding.step2_body_done") : t("onboarding.step2_body"),
      done: setup.blockSeen,
      action: setup.blockSeen ? undefined : { label: t("onboarding.step2_action"), href: checkoutEditorUrl(setup.shopHandle) },
    },
    { title: t("onboarding.step3_title"), body: t("onboarding.step3_body"), done: false },
    {
      title: t("onboarding.step4_title"),
      body: t("onboarding.step4_body"),
      done: false,
      action: { label: t("onboarding.step4_action"), href: "/app/results" },
    },
  ];
  // The first step not yet done carries the page's one primary button.
  const current = steps.findIndex((step) => !step.done);

  return (
    <s-stack gap="base">
      {setup.hasExplicitLanguage ? null : (
        <Panel title={t("onboarding.language_step_title")}>
          <s-stack gap="base">
            <s-text color="subdued">{t("onboarding.language_step_body")}</s-text>
            {/* The full grid, not a dropdown: a first-time visitor who cannot
                read the current language cannot operate a dropdown they cannot
                read either. */}
            <LanguageForm language={language} detected />
          </s-stack>
        </Panel>
      )}

      <s-section heading={t("onboarding.title")}>
        <s-stack gap="base">
          <s-text color="subdued">{t("onboarding.subtitle")}</s-text>
          {steps.map((step, index) => (
            <s-box key={step.title} padding="base" border="base" borderRadius="large">
              {/* Number on the left, text on the right: the text column can
                  shrink, so long translations wrap instead of overflowing. */}
              <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="base" alignItems="start">
                {step.done ? (
                  <s-badge tone="success" icon="check">
                    {t("common.done")}
                  </s-badge>
                ) : (
                  <s-badge tone={index === current ? "info" : "neutral"}>{String(index + 1)}</s-badge>
                )}
                <s-stack gap="small">
                  <s-text type="strong">{step.title}</s-text>
                  <s-text color="subdued">{step.body}</s-text>
                  {step.action ? (
                    <div>
                      {/* Shopify admin pages refuse to render inside the app's
                          iframe, so the checkout editor opens in the top window.
                          In-app links stay in the frame. One primary action on
                          the page: the first step not yet done. */}
                      <s-button
                        href={step.action.href}
                        target={step.action.href.startsWith("https://") ? "_top" : "auto"}
                        variant={index === current ? "primary" : "secondary"}
                      >
                        {step.action.label}
                      </s-button>
                    </div>
                  ) : null}
                </s-stack>
              </s-grid>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-stack>
  );
}

export default function Home() {
  const data = useLoaderData<typeof loader>();
  const { t, language, locale } = useAdminI18n();

  if (data.setup) return <SetupGuide setup={data.setup} t={t} language={language} />;
  const dashboard = data.dashboard;
  if (!dashboard) return null;

  const { report } = dashboard;
  const rangeLabel = t(DASHBOARD_RANGE_LABEL_KEYS[dashboard.days]);
  const reportHref = `/app/dashboard?range=${dashboard.days}`;

  return (
    <s-stack gap="base">
      {/* What this page is, and one range for every section on it. */}
      <PageIntro
        actions={
          <RangeSwitcher
            label={t("dashboard.range_label")}
            options={DASHBOARD_RANGES.map((days) => ({
              key: String(days),
              label: t(DASHBOARD_RANGE_LABEL_KEYS[days]),
              href: `/app?range=${days}`,
              current: days === dashboard.days,
            }))}
          />
        }
      >
        {t("home.subtitle")}
      </PageIntro>

      {/* 1. The four attribution numbers; each tile opens the channel report. */}
      <KpiGrid report={report} t={t} locale={locale} rangeLabel={rangeLabel} href={reportHref} />
      <ReportNotes summary={report.summary} t={t} />

      {/* 2. How buyers rate the store: NPS and CSAT across every survey. */}
      <ScoresSection scores={dashboard.scores} t={t} locale={locale} rangeLabel={rangeLabel} days={dashboard.days} />

      {/* 3. Where buyers come from, and who they are. */}
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 760px) repeat(2, minmax(0, 1fr)), minmax(0, 1fr)"
          gap="base"
        >
          <TopChannels report={report} t={t} locale={locale} rangeLabel={rangeLabel} reportHref={reportHref} />
          <BuyerMix buyers={dashboard.buyers} t={t} locale={locale} />
        </s-grid>
      </s-query-container>

      {/* 4. Each survey's key result, and the one thing to do next. The next
          step comes first on a phone: it is the one action on the page. */}
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 760px) minmax(0, 1fr) minmax(0, 2fr), minmax(0, 1fr)"
          gap="base"
        >
          <NextStep
            surveys={dashboard.surveys}
            spotlightTemplateName={data.spotlightTemplateName}
            channelCompassName={data.channelCompassName}
            t={t}
          />
          <SurveysOverview
            surveys={dashboard.surveys}
            surveyCount={dashboard.surveyCount}
            t={t}
            locale={locale}
            rangeLabel={rangeLabel}
            days={dashboard.days}
          />
        </s-grid>
      </s-query-container>

      {/* 5. The daily trend. */}
      <Panel title={t("dashboard.trend_title")} description={t("dashboard.trend_subtitle", { range: rangeLabel })}>
        <Sparkline points={report.trend} t={t} locale={locale} />
      </Panel>

      {dashboard.cappedAt !== null ? (
        <s-text color="subdued" fontSize="small">
          {t("home.capped_note", { limit: new Intl.NumberFormat(locale).format(dashboard.cappedAt) })}
        </s-text>
      ) : null}
    </s-stack>
  );
}

/**
 * The single next-step suggestion.
 *
 * Priority: unpublished changes first (they need a decision), then a reliable
 * survey's ideas, then a seasonal spotlight, then starting from a template.
 */
function NextStep({
  surveys,
  spotlightTemplateName,
  channelCompassName,
  t,
}: {
  surveys: DashboardSurvey[];
  spotlightTemplateName: string | null;
  channelCompassName: string;
  t: TFunction;
}) {
  const draft = surveys.find((s) => s.hasDraft);
  const reliable = surveys.find((s) => s.confidence === "reliable");

  let body: string;
  let href = "/app/surveys";
  if (draft) {
    body = t("home.unpublished", { name: draft.name });
    href = `/app/surveys/${draft.id}`;
  } else if (reliable) {
    body = t("home.reliable_ideas", { name: reliable.name });
    href = `/app/results?survey=${reliable.id}`;
  } else if (spotlightTemplateName) {
    body = t("home.start_with", { name: spotlightTemplateName });
    href = "/app/surveys/library";
  } else if (surveys.length === 0) {
    body = t("home.start_with", { name: channelCompassName });
    href = "/app/surveys/library";
  } else {
    // Not yet reliable, so it must not say so.
    body = t("home.see_results", { name: surveys[0]?.name ?? "" });
    href = `/app/results?survey=${surveys[0]?.id ?? ""}`;
  }

  return (
    <s-section heading={t("home.next_step")}>
      <s-stack gap="base">
        <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
          <s-icon type="lightbulb" tone="info" />
          <s-text>{body}</s-text>
        </s-grid>
        <div>
          <s-button href={href} variant="primary">
            {t("home.do_it")}
          </s-button>
        </div>
      </s-stack>
    </s-section>
  );
}
