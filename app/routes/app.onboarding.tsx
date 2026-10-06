import { Link, useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { LanguageForm } from "~/components/language-selector";
import { db } from "~/db.server";
import { createTranslator, isSupportedLanguage } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle } from "~/lib/i18n/use-admin-i18n";
import { MAX_OPTIONS, MIN_OPTIONS } from "~/lib/settings";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * First-run onboarding: a three-step checklist.
 *
 * A step is only reported as done when we can prove it from our own data. For
 * step 1 we deliberately do NOT claim to know whether the block is enabled in
 * the checkout editor: the Admin API exposes no such state, and guessing would
 * be worse than asking the merchant to confirm. Shopify sends no event when an
 * extension block is toggled.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "onboarding.title");

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const [responseCount, orderCount] = await Promise.all([
    db.surveyResponse.count({ where: { shopId: shop.id } }),
    db.orderCache.count({ where: { shopId: shop.id } }),
  ]);
  return {
    shopDomain: shop.shopDomain,
    hasResponses: responseCount > 0,
    hasOrders: orderCount > 0,
    hasOther: shop.allowOther,
    // Resolved here rather than read from the shell's loader data so this page
    // can translate itself. Same inputs in the same order, so the two can never
    // disagree about which language is on screen.
    language: resolveAdminLanguage(request, shop.language),
    /**
     * False until the merchant picks a language themselves. While it is false the
     * picker is offered here as step 1; once they choose, the shell's permanent
     * switcher takes over and this step stops appearing.
     */
    hasExplicitLanguage: isSupportedLanguage(shop.language),
  };
});

type Step = { title: string; body: string; done: boolean; action?: { label: string; href: string } };

export default function Onboarding() {
  const data = useLoaderData<typeof loader>();
  const t = createTranslator(data.language);

  // The checkout editor URL is admin-only and needs the shop handle. Building it
  // here keeps the link correct per store rather than hardcoding a path.
  //
  // This must be the *checkout* editor (Settings › Checkout › Customize), not
  // the Online Store theme editor (`/themes/current/editor`) it once pointed
  // at. Thank-you and order-status blocks are checkout UI extensions and only
  // exist in the checkout editor, so the old link sent merchants somewhere the
  // SourceTrac block could never be found. `page=thank-you` opens the editor on
  // the page the block belongs to.
  const editorUrl = `https://admin.shopify.com/store/${data.shopDomain.replace(/\.myshopify\.com$/, "")}/settings/checkout/editor?page=thank-you`;

  const steps: Step[] = [
    {
      title: t("onboarding.step1_title"),
      body: data.hasOrders ? t("onboarding.step1_body_orders") : t("onboarding.step1_body"),
      done: false,
      action: { label: t("onboarding.step1_action"), href: editorUrl },
    },
    {
      title: t("onboarding.step2_title"),
      body: data.hasOther
        ? t("onboarding.step2_body_other")
        : t("onboarding.step2_body", { min: MIN_OPTIONS, max: MAX_OPTIONS }),
      done: false,
      action: { label: t("onboarding.step2_action"), href: "/app/settings" },
    },
    {
      title: t("onboarding.step3_title"),
      body: data.hasResponses ? t("onboarding.step3_body_done") : t("onboarding.step3_body"),
      done: data.hasResponses,
      action: data.hasResponses ? { label: t("onboarding.step3_action"), href: "/app" } : undefined,
    },
  ];

  // Language is the very first thing a merchant should confirm, and it is only
  // ever offered here while `hasExplicitLanguage` is false. The picker itself is
  // rendered outside the list, because a `s-clickable` grid has no place inside
  // an ordered list item without nesting interactive content in a step.
  const showLanguageStep = !data.hasExplicitLanguage;

  const complete = steps.filter((step) => step.done).length;

  return (
    <s-stack gap="base">
      <s-section heading={t("onboarding.title")} subheading={t("onboarding.subtitle")} padding="none" />

      {showLanguageStep ? (
        <Panel title={t("onboarding.language_step_title")}>
          <s-stack gap="base">
            <s-text color="subdued">{t("onboarding.language_step_body")}</s-text>
            {/*
              `variant="dialog"` renders the full ten-language grid with a
              confirm button, rather than the compact dropdown the shell uses. A
              first-time visitor who may not read the current language at all
              cannot be expected to operate a dropdown they cannot read.
            */}
            <LanguageForm language={data.language} detected />
          </s-stack>
        </Panel>
      ) : null}

      {/* Plan-blocked is shown by the shell on every page, so not repeated here. */}

      <Panel title={t("onboarding.progress_title", { count: complete, done: complete, total: steps.length })}>
        <s-stack gap="base">
          <s-progress value={complete} max={steps.length} accessibilityLabel={t("onboarding.progress_aria", { done: complete, total: steps.length })} />

          <s-ordered-list>
            {steps.map((step, index) => (
              <li key={step.title}>
                <s-stack gap="small">
                  <s-text type={step.done ? "strong" : "generic"}>
                    {index + 1}. {step.title}
                  </s-text>
                  {step.done ? <s-badge tone="success">{t("common.done")}</s-badge> : null}
                  <s-text color="subdued">{step.body}</s-text>
                  {step.action ? (
                    <div>
                      {/* Shopify admin pages refuse to render inside the app's
                          iframe, so the checkout editor opens in the top
                          window. In-app links stay in the frame. */}
                      <s-link
                        href={step.action.href}
                        target={step.action.href.startsWith("https://") ? "_top" : "auto"}
                      >
                        {step.action.label}
                      </s-link>
                    </div>
                  ) : null}
                </s-stack>
              </li>
            ))}
          </s-ordered-list>
        </s-stack>
      </Panel>

      <Banner tone="info" heading={t("onboarding.why_title")}>
        <s-text>{t("onboarding.why_body")}</s-text>
      </Banner>
    </s-stack>
  );
}