import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";

import { Banner, Panel } from "~/components/admin-ui";
import { KpiGrid, TopChannelCallout } from "~/components/channel-report";
import { ConfidenceBadge } from "~/components/insights";
import { loadChannelReport } from "~/lib/channel-report.server";
import { LanguageForm } from "~/components/language-selector";
import { db } from "~/db.server";
import { isSupportedLanguage, type LanguageCode } from "~/lib/i18n";
import { MAX_OPTIONS, MIN_OPTIONS } from "~/lib/settings";
import { hasAnyResponse, loadHomeSurveys, type HomeSurvey } from "~/lib/home.server";
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
import { authenticate } from "~/shopify.server";

/**
 * Home — the landing page.
 *
 * Answers "how is it going, and what should I do next?" in one screen: the best
 * channel of the last 30 days in one sentence, the four headline numbers (each a
 * link to the full channel report), the live surveys with one key number each,
 * and exactly one next step. The range switcher, table and trend live on the
 * channel report. Until the first answer arrives this page is the setup guide.
 *
 * All money is formatted here on the server and shipped as strings, so the
 * browser never sees minor-unit integers.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "nav.home");

export const handle = { titleKey: "nav.home" };

/** Home's numbers cover the last 30 days, the channel report's default range. */
const HOME_DAYS = 30;

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

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));

  const [anyResponse, firstOrder] = await Promise.all([
    // Ever, not in a window: a quiet week must not send an established
    // merchant back to the setup guide.
    hasAnyResponse(shop.id),
    db.orderCache.findFirst({ where: { shopId: shop.id }, select: { id: true } }),
  ]);

  const [homeSurveys, report] = anyResponse
    ? await Promise.all([loadHomeSurveys(shop.id, locale), loadChannelReport({ shop, days: HOME_DAYS, locale })])
    : [[], null];

  // The seasonal spotlight (T15) is the fallback next step when nothing more
  // urgent applies. Evaluated in the admin from the date and the shop's region:
  // no database, no network.
  const templateLocale = shop.language ?? "en";
  let spotlightTemplateName: string | null = null;
  if (homeSurveys.length > 0) {
    const { countryCode, timeZone } = await getShopLocaleInfo(shop.id, shop.shopDomain, session.accessToken);
    const spotlight = currentSpotlight({
      locale: templateLocale,
      region: regionPackFor(countryCode),
      now: new Date(),
      timeZone: timeZone ?? "UTC",
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
            hasOrders: firstOrder !== null,
            hasOther: shop.allowOther,
            // False until the merchant picks a language themselves; while it is
            // false the full picker is offered as the first setup step.
            hasExplicitLanguage: isSupportedLanguage(shop.language),
          }
        : null,
    homeSurveys,
    report,
    spotlightTemplateName,
    // Template names live in the shared template bundle, not the admin i18n
    // bundle, so the fallback "Start with Channel Compass" name is resolved here.
    channelCompassName: templateText(templateLocale, "templates.channel-compass.name"),
  };
});

type Setup = {
  shopHandle: string;
  hasOrders: boolean;
  hasOther: boolean;
  hasExplicitLanguage: boolean;
};

/**
 * First-run checklist, shown on Home until the first answer arrives.
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
      action: { label: t("onboarding.step2_action"), href: "/app/surveys" },
    },
    {
      title: t("onboarding.step3_title"),
      body: t("onboarding.step3_body"),
    },
    {
      title: t("onboarding.step4_title"),
      body: t("onboarding.step4_body"),
      action: { label: t("onboarding.step4_action"), href: "/app/results" },
    },
  ];

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
                <s-badge tone={index === 0 ? "info" : "neutral"}>{String(index + 1)}</s-badge>
                <s-stack gap="small">
                  <s-text type="strong">{step.title}</s-text>
                  <s-text color="subdued">{step.body}</s-text>
                  {step.action ? (
                    <div>
                      {/* Shopify admin pages refuse to render inside the app's
                          iframe, so the checkout editor opens in the top window.
                          In-app links stay in the frame. One primary action on
                          the page: the step that unblocks everything else. */}
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
              </s-grid>
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

export default function Home() {
  const data = useLoaderData<typeof loader>();
  const { t, language, locale } = useAdminI18n();

  if (data.setup) return <SetupGuide setup={data.setup} t={t} language={language} />;

  const surveys = data.homeSurveys;
  const rangeLabel = t("dashboard.last_30");

  return (
    <s-stack gap="base">
      {/* 1. The headline: the best channel, in one sentence. */}
      {data.report ? (
        <TopChannelCallout
          report={data.report}
          t={t}
          rangeLabel={rangeLabel}
          action={{ href: "/app/dashboard", label: t("home.open_report") }}
        />
      ) : null}

      {/* 2. The four numbers behind it; each tile opens the full report. */}
      {data.report ? (
        <KpiGrid report={data.report} t={t} locale={locale} rangeLabel={rangeLabel} href="/app/dashboard" />
      ) : null}

      {/* 3. Next step and live surveys, side by side on desktop. The next step
          comes first on a phone: it is the one thing to do. */}
      <s-query-container>
        <s-grid gridTemplateColumns="@container (inline-size > 760px) minmax(0, 1fr) minmax(0, 2fr), minmax(0, 1fr)" gap="base">
          <NextStep
            surveys={surveys}
            spotlightTemplateName={data.spotlightTemplateName}
            channelCompassName={data.channelCompassName}
            t={t}
          />

          <s-section heading={t("home.your_surveys")}>
            {surveys.length === 0 ? (
              <s-stack gap="base">
                <s-text color="subdued">{t("surveys.empty_body")}</s-text>
                <div>
                  <s-button href="/app/surveys/library">{t("surveys.use_template")}</s-button>
                </div>
              </s-stack>
            ) : (
              <s-stack gap="small">
                {surveys.map((survey) => (
                  <HomeSurveyRow key={survey.id} survey={survey} t={t} />
                ))}
                <div>
                  <s-link href="/app/surveys">{t("home.view_all")}</s-link>
                </div>
              </s-stack>
            )}
          </s-section>
        </s-grid>
      </s-query-container>
    </s-stack>
  );
}

function HomeSurveyRow({ survey, t }: { survey: HomeSurvey; t: TFunction }) {
  return (
    <s-clickable href={`/app/surveys/${survey.id}`} padding="base" border="base" borderRadius="large">
      {/* Name and key number in a grid whose text column can shrink: a long
          survey name wraps instead of pushing the number out of the card. */}
      <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
        <s-stack gap="small-200">
          <s-text type="strong">{survey.name}</s-text>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="success">{t("surveys.status_active")}</s-badge>
            <ConfidenceBadge level={survey.confidence} n={survey.responseCount} t={t} />
          </s-stack>
        </s-stack>
        <s-text fontWeight="bold" fontVariantNumeric="tabular-nums">
          {survey.keyNumber}
        </s-text>
      </s-grid>
    </s-clickable>
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
  surveys: HomeSurvey[];
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
    href = `/app/surveys/${draft.id}?tab=studio`;
  } else if (reliable) {
    body = t("home.reliable_ideas", { name: reliable.name });
    href = `/app/surveys/${reliable.id}?tab=results`;
  } else if (spotlightTemplateName) {
    body = t("home.start_with", { name: spotlightTemplateName });
    href = "/app/surveys/library";
  } else if (surveys.length === 0) {
    body = t("home.start_with", { name: channelCompassName });
    href = "/app/surveys/library";
  } else {
    body = t("home.reliable_ideas", { name: surveys[0]?.name ?? "" });
    href = `/app/surveys/${surveys[0]?.id ?? ""}?tab=results`;
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
