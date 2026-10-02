import {
  NavLink,
  Outlet,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";

import { Banner } from "~/components/admin-ui";
import { LanguageForm } from "~/components/language-selector";
import { createTranslator, intlLocaleFor, isSupportedLanguage } from "~/lib/i18n";
import { languageFor } from "~/lib/i18n/languages";
import { resolveRequestLanguage } from "~/lib/i18n/resolve.server";
import { evaluateCap, planFor } from "~/lib/plans";
import { getUsageCount } from "~/lib/responses.server";
import { requireShopByDomain as requireShop } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * Authenticated shell for the embedded admin.
 *
 * `authenticate.admin` throws a redirect to Shopify when there is no valid
 * session, so every child route inherits authentication from this loader — child
 * loaders do not need to check it again.
 *
 * This loader also resolves the two things every screen needs: the shop record
 * and the current month's usage. Both are needed for the cap banner, so they
 * are fetched once here rather than re-queried per screen.
 */

/**
 * Nav entries. The label is an i18next key, not display text: this array is a
 * module-level constant shared by every request, so a translated string could
 * never be stored here without leaking one merchant's language into the next
 * tenant's page. Keys are resolved per render.
 */
const NAV = [
  { to: "/app", key: "nav.dashboard", icon: "home", end: true },
  { to: "/app/onboarding", key: "nav.onboarding", icon: "check", end: false },
  { to: "/app/settings", key: "nav.settings", icon: "settings", end: false },
  { to: "/app/export", key: "nav.export", icon: "download", end: false },
  { to: "/app/plans", key: "nav.plans", icon: "money", end: false },
  { to: "/app/help", key: "nav.help", icon: "question", end: false },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await requireShop(session.shop);
  const used = await getUsageCount(shop.id);

  const url = new URL(request.url);
  const language = resolveRequestLanguage({
    requested: url.searchParams.get("lng"),
    saved: shop.language,
    shopifyLocale: url.searchParams.get("locale"),
    acceptLanguage: request.headers.get("accept-language"),
  });

  return {
    shop,
    used,
    plan: planFor(shop.plan),
    cap: evaluateCap(shop.plan, used),
    language,
    /**
     * Whether the language came from the merchant's own choice. When false the
     * onboarding screen offers the picker with the detected value preselected.
     */
    hasExplicitLanguage: isSupportedLanguage(shop.language),
  };
};

/**
 * Persist a language change.
 *
 * Deliberately NOT here. A `<fetcher>` without an explicit `action` posts to the
 * nearest route in the tree, so the language picker — which renders on every
 * admin page — would post to whichever page the merchant happened to be on, and
 * on `/app/settings` that is the survey-settings action. The save lives at
 * `/app/language` instead; see `app/routes/app.language.tsx`.
 */

export default function AdminLayout() {
  const { shop, plan, cap, language, hasExplicitLanguage } = useLoaderData<typeof loader>();
  const t = createTranslator(language);
  const locale = intlLocaleFor(language);

  return (
    <s-page>
      <s-grid gridTemplateColumns="auto 1fr" gap="base">
        <s-grid-item>
          <s-box background="subdued" padding="small" borderRadius="base">
            <s-stack gap="base">
              <s-stack gap="small">
                <s-text type="strong">SourceTrac</s-text>
                <s-text color="subdued" fontSize="small">
                  {shop.shopDomain}
                </s-text>
              </s-stack>

              <s-divider />

              {/* Nav is a list so screen readers announce position and count. */}
              <nav aria-label={t("nav.label")}>
                <s-unordered-list>
                  {NAV.map((item) => (
                    <li key={item.to}>
                      <NavLink to={item.to} end={item.end}>
                        {({ isActive }) => (
                          <s-text type={isActive ? "strong" : "generic"}>{t(item.key)}</s-text>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </s-unordered-list>
              </nav>

              <s-divider />

              <s-stack gap="small">
                <s-text color="subdued" fontSize="small">
                  {plan.name}
                </s-text>
                {cap.cap !== null ? (
                  <s-progress
                    value={cap.used}
                    max={cap.cap}
                    accessibilityLabel={t("plans.usage_aria", { count: cap.used, cap: cap.cap })}
                  />
                ) : null}
                <s-text color="subdued" fontSize="small">
                  {cap.cap === null
                    ? t("plans.unlimited")
                    : t("plans.usage", { count: cap.used, cap: cap.cap })}
                </s-text>
              </s-stack>
            </s-stack>
          </s-box>
        </s-grid-item>

        <s-grid-item>
          <s-box padding="base">
            <s-stack gap="base">
              {/* Plan-blocked takes precedence: the survey cannot appear at all,
                  so explaining the cap would be a distraction. */}
              {shop.checkoutSupported === false ? (
                <Banner tone="warning" heading={t("shell.plan_blocked_title")}>
                  {t("shell.plan_blocked_body")}
                </Banner>
              ) : cap.atWarning && !cap.atCap ? (
                <Banner
                  tone="warning"
                  heading={t("shell.cap_warning_title", { used: cap.used, cap: cap.cap })}
                >
                  <s-stack gap="small">
                    <s-text>{t("shell.cap_warning_body", { cap: cap.cap })}</s-text>
                    <s-button href="/app/plans" variant="primary">
                      {t("shell.cap_warning_cta")}
                    </s-button>
                  </s-stack>
                </Banner>
              ) : cap.atCap ? (
                <Banner tone="critical" heading={t("shell.cap_reached_title")}>
                  <s-stack gap="small">
                    <s-text>{t("shell.cap_reached_body")}</s-text>
                    <s-button href="/app/plans" variant="primary">
                      {t("shell.cap_reached_cta")}
                    </s-button>
                  </s-stack>
                </Banner>
              ) : null}

              {/*
                A compact switcher sits in the main column rather than the
                sidebar: the sidebar is already three stacked sections, and the
                picker is a settings concern rather than navigation. It is always
                present, not only during onboarding, so a merchant who picked
                their language once can always change it back.
              */}
              <div className="st-lang-bar">
                <LanguageForm language={language} detected={!hasExplicitLanguage} inline />
              </div>

              <Outlet />
            </s-stack>
          </s-box>
        </s-grid-item>
      </s-grid>
    </s-page>
  );
}