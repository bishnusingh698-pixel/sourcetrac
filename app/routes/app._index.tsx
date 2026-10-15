import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";

import { Banner, Panel } from "~/components/admin-ui";
import { ConfidenceBadge } from "~/components/insights";
import { LanguageForm } from "~/components/language-selector";
import { db } from "~/db.server";
import { isSupportedLanguage, type LanguageCode } from "~/lib/i18n";
import { MAX_OPTIONS, MIN_OPTIONS } from "~/lib/settings";
import { hasAnyResponse, loadHomeSurveys, type HomeSurvey } from "~/lib/home.server";
import { ensureShop } from "~/lib/provision.server";
import { backfillMissingOrders } from "~/lib/order-backfill.server";
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
 * Home (T16) — the minimal landing page.
 *
 * Exactly three cards: status, up to three active surveys with one key number
 * each, and one rule-based next step. Everything else (the full channel report,
 * the trend, the range switcher) moved to `/app/dashboard`, which is linked from
 * the status card. Until the first answer arrives this page is the setup guide.
 *
 * All money is formatted here on the server and shipped as strings, so the
 * browser never sees minor-unit integers.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "dashboard.title");

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  // Orders the webhooks never delivered (placed before install, for one) are
  // fetched now, so their answers stop reading "Pending". Bounded and never throws.
  await backfillMissingOrders({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  // Retry any deferred Shopify write-back (Phase 7) and drain any redact that
  // was too large for the webhook budget (Phase 8). Throttled to once per few
  // minutes per process, and never throws, so neither can break the page.
  void maybeRunPendingSync(shop.id);
  void maybeRunPendingDeletions(shop.id);

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));

  const [anyResponse, firstOrder] = await Promise.all([
    // Ever, not in a window: a quiet week must not send an established
    // merchant back to the setup guide.
    hasAnyResponse(shop.id),
    db.orderCache.findFirst({ where: { shopId: shop.id }, select: { id: true } }),
  ]);

  const homeSurveys = anyResponse ? await loadHomeSurveys(shop.id, locale) : [];

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

export default function Home() {
  const data = useLoaderData<typeof loader>();
  const { t, language } = useAdminI18n();

  if (data.setup) return <SetupGuide setup={data.setup} t={t} language={language} />;

  const surveys = data.homeSurveys;

  return (
    <s-stack gap="base">
      {/* Card 1: status. One sentence, or one action. */}
      <Panel title={t("dashboard.title")} description={t("home.status_live")}>
        <s-link href="/app/dashboard">{t("dashboard.channels_title")}</s-link>
      </Panel>

      {/* Card 2: up to three active surveys, one key number each. */}
      <Panel title={t("home.your_surveys")}>
        {surveys.length === 0 ? (
          <s-text color="subdued">{t("surveys.empty_body")}</s-text>
        ) : (
          <s-stack gap="base">
            {surveys.map((survey) => (
              <HomeSurveyRow key={survey.id} survey={survey} t={t} />
            ))}
            <s-link href="/app/surveys">{t("home.view_all")}</s-link>
          </s-stack>
        )}
      </Panel>

      {/* Card 3: exactly one rule-based next step. */}
      <NextStep
        surveys={surveys}
        spotlightTemplateName={data.spotlightTemplateName}
        channelCompassName={data.channelCompassName}
        t={t}
      />
    </s-stack>
  );
}

function HomeSurveyRow({ survey, t }: { survey: HomeSurvey; t: TFunction }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small">
        <s-stack direction="inline" justifyContent="space-between" gap="small" alignItems="center">
          <s-text type="strong">{survey.name}</s-text>
          <s-heading>{survey.keyNumber}</s-heading>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between" gap="small" alignItems="center">
          <ConfidenceBadge level={survey.confidence} n={survey.responseCount} t={t} />
          <s-link href={`/app/surveys/${survey.id}`}>{t("home.view")}</s-link>
        </s-stack>
      </s-stack>
    </s-box>
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
    <Panel title={t("home.next_step")} description={body}>
      <s-link href={href}>{t("home.view")}</s-link>
    </Panel>
  );
}
