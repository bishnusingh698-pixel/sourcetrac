import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useLocation,
  useMatches,
  useNavigate,
  useRouteError,
  useRouteLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * Type-only import, for the shape of the root loader's return value.
 *
 * Deliberately not a value import: `app.tsx` is rendered by `root.tsx`, so
 * importing the module for its value would pull the root route back into its own
 * child at runtime and risk a cycle. The shape alone is enough, and it stays in
 * sync automatically because TypeScript re-checks it whenever the root loader
 * changes.
 */
import type { loader as rootLoader } from "~/root";

import { Banner } from "~/components/admin-ui";
import { SupportIconButton } from "~/components/support-button";
import { DataNotice } from "~/components/data-notice";
import { TopNav } from "~/components/top-nav";
import { NAV } from "~/lib/nav";
import {
  createTranslator,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  languageStrings,
} from "~/lib/i18n";
import { shellTranslator } from "~/lib/i18n/use-admin-i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { rememberAdminLocale } from "~/lib/shop.server";
import { effectivePlan, evaluateCap, planFor } from "~/lib/plans";
import { getUsageCount } from "~/lib/responses.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { RECORD_RETENTION_DAYS } from "~/lib/retention.server";
import { authenticate } from "~/shopify.server";
import { isShopifyAuthResponse } from "~/lib/shopify-boundary";
import { ShopifyAuthPage } from "~/components/shopify-auth-page";
import { APP_VERSION } from "@shared/support";

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
 * The pages themselves are listed once, in `~/lib/nav`, and read by both menus:
 * Shopify's own admin navigation (`<s-app-nav>`, the `sidebar` items) and the
 * in-app top bar (`TopNav`, every item).
 */

/**
 * The page title shown in the page header, from the deepest route that
 * declares one (`export const handle = { titleKey }`). The shell owns the only
 * `<s-page>`, so child routes name their title this way instead of drawing a
 * heading of their own.
 */
function usePageTitleKey(): string | null {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const handle = matches[i]?.handle as { titleKey?: unknown } | undefined;
    if (handle && typeof handle.titleKey === "string") return handle.titleKey;
  }
  return null;
}

/**
 * App Bridge reads `rel="home"` off the first `s-link`, but Polaris's `s-link`
 * type does not declare `rel`. Spread rather than written inline so the extra
 * attribute is not rejected by the excess-property check.
 */
const HOME_LINK = { rel: "home" } as const;

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const used = await getUsageCount(shop.id);
  // The plan whose limits are enforced, not merely the stored one: a cancelled
  // subscription must show the Free cap the API is actually applying.
  const enforcedPlan = effectivePlan(shop);

  const shopifyLocale = new URL(request.url).searchParams.get("locale");
  if (shopifyLocale && shopifyLocale !== shop.adminLocale) {
    await rememberAdminLocale(shop.id, shopifyLocale);
  }
  const language = resolveAdminLanguage(request, shop.language, shopifyLocale ?? shop.adminLocale);

  return {
    /**
     * App Bridge needs the public Client ID on the client. This is the
     * publishable Partner Dashboard key, never the API secret.
     */
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    // Only what the shell renders. Loader data is sent to the browser, and the
    // full record carried the billing subscription id and internal fields.
    shop: { shopDomain: shop.shopDomain, checkoutSupported: shop.checkoutSupported },
    used,
    plan: planFor(enforcedPlan),
    cap: evaluateCap(enforcedPlan, used),
    language,
    /**
     * This language's strings. The browser bundle carries English only, so
     * the merchant's language travels here, once per document load (see
     * `shouldRevalidate`). Null for English.
     */
    messages: language === DEFAULT_LANGUAGE ? null : languageStrings(language),
    /**
     * Version stamped into the support mail body. `npm_package_version` is set
     * by npm for `npm start`; the constant is the fallback for other runners.
     */
    version: process.env.npm_package_version ?? APP_VERSION,
    /**
     * Whether the language came from the merchant's own choice. When false the
     * dashboard's setup guide offers the full picker, detected value preselected.
     */
    hasExplicitLanguage: isSupportedLanguage(shop.language),
    /** For the privacy line at the foot of every page. */
    retentionMonths: Math.round(RECORD_RETENTION_DAYS / 30),
  };
});

/**
 * Persist a language change.
 *
 * Deliberately NOT here. A `<fetcher>` without an explicit `action` posts to the
 * nearest route in the tree, so the language picker — which renders on every
 * admin page — would post to whichever page the merchant happened to be on, and
 * on `/app/settings` that is the survey-settings action. The save lives at
 * `/app/language` instead; see `app/routes/app.language.tsx`.
 */

/**
 * The shell's data (plan, usage, language and its strings) only changes after
 * a form submission or an explicit revalidate. A page switch or a filter change
 * (`?range=`, `?survey=`) used to re-run this loader too, a second admin
 * authentication and the language strings sent again on every click.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formMethod, currentUrl, nextUrl, defaultShouldRevalidate }) => {
  if (formMethod) return defaultShouldRevalidate;
  // `revalidate()` keeps the URL; anything else is a move to another page or filter.
  if (currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
};

export default function AdminLayout() {
  const { apiKey, shop, plan, cap, language, messages, version, retentionMonths } = useLoaderData<typeof loader>();
  const t = shellTranslator(language, messages);
  const location = useLocation();
  const titleKey = usePageTitleKey();

  return (
    <AppProvider apiKey={apiKey}>
      {/* Shopify admin's own sidebar entries for this app. Without this the
          app shows no pages under its name in the admin navigation. The
          in-app top bar below lists the same pages plus Dashboard and Export. */}
      <s-app-nav>
        <s-link href="/app" {...HOME_LINK}>
          {t("nav.home")}
        </s-link>
        {NAV.filter((item) => item.sidebar).map((item) => (
          <s-link key={item.to} href={item.to}>
            {t(item.key)}
          </s-link>
        ))}
      </s-app-nav>
      <s-page heading={titleKey ? t(titleKey) : undefined}>
        {/* Always one click away, in the page title bar's secondary-actions
            slot. `page` is the current path so the mail body says where the
            merchant was when they asked for help. */}
        <SupportIconButton
          slot="secondary-actions"
          shop={shop.shopDomain}
          plan={t(`plans.${plan.key}`)}
          version={version}
          page={location.pathname}
        />
        {/* `st-page` makes long words, shop domains and translations wrap
            inside their card instead of running past its edge. */}
        <div className="st-page">
        <s-stack gap="base">
          {/* The app's own menu, on every page. */}
          <TopNav t={t} />

          {/* Plan strip: only on the Free plan, where the monthly limit is
              something to watch. A paid merchant has nothing to act on here,
              and an always-on toolbar was clutter on every page. */}
          {cap.cap !== null && !cap.atWarning && shop.checkoutSupported !== false ? (
            <s-box padding="small" border="base" borderRadius="base" background="base">
              <s-query-container>
                <s-grid
                  gridTemplateColumns="@container (inline-size > 560px) auto minmax(0, 1fr) auto, minmax(0, 1fr)"
                  gap="small"
                  alignItems="center"
                >
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone="neutral">{t(`plans.${plan.key}`)}</s-badge>
                    <s-text color="subdued" fontSize="small" fontVariantNumeric="tabular-nums">
                      {t("plans.usage", { count: cap.used, cap: cap.cap })}
                    </s-text>
                  </s-stack>
                  <s-progress
                    value={Math.min(cap.used, cap.cap)}
                    max={cap.cap}
                    tone="success"
                    accessibilityLabel={t("plans.usage_aria", { count: cap.used, cap: cap.cap })}
                  />
                  <s-link href="/app/plans">{t("shell.see_plans")}</s-link>
                </s-grid>
              </s-query-container>
            </s-box>
          ) : null}

          {/* One banner at a time (Shopify's guideline). Plan-blocked takes
              precedence: the survey cannot appear at all, so explaining the
              cap would be a distraction. */}
          {shop.checkoutSupported === false ? (
            <Banner tone="warning" heading={t("shell.plan_blocked_title")}>
              {t("shell.plan_blocked_body")}
            </Banner>
          ) : cap.atWarning && !cap.atCap ? (
            <Banner
              tone="warning"
              heading={t("shell.cap_warning_title", {
                used: cap.used,
                cap: cap.cap,
              })}
            >
              <s-stack gap="small">
                <s-text>
                  {/* Plural-only key: without `count` i18next skips the `_one` /
                      `_other` lookup and renders the raw key. */}
                  {t("shell.cap_warning_body", { count: cap.cap ?? 0, cap: cap.cap })}
                </s-text>
                <div>
                  <s-button href="/app/plans" variant="primary">
                    {t("shell.cap_warning_cta")}
                  </s-button>
                </div>
              </s-stack>
            </Banner>
          ) : cap.atCap ? (
            <Banner tone="critical" heading={t("shell.cap_reached_title")}>
              <s-stack gap="small">
                <s-text>{t("shell.cap_reached_body")}</s-text>
                <div>
                  <s-button href="/app/plans" variant="primary">
                    {t("shell.cap_reached_cta")}
                  </s-button>
                </div>
              </s-stack>
            </Banner>
          ) : null}

          <Outlet />

          {/* First layer of the privacy notice, on every page; the full
              account is one tap away on /app/privacy. */}
          <DataNotice t={t} months={retentionMonths} />
        </s-stack>
        </div>
      </s-page>
    </AppProvider>
  );
}

/**
 * Shell-level error boundary.
 *
 * A child route's loader failing (a database blip, an expired session mid-read)
 * would otherwise bubble to the root boundary and replace the whole document
 * with a bare page, losing the admin chrome. This keeps the shell and names the
 * failure instead.
 */
/** Lets Shopify's re-auth / retry headers through on thrown auth responses. */
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  const error = useRouteError();
  if (isShopifyAuthResponse(error)) return <ShopifyAuthPage error={error} fallback={<AdminErrorScreen error={error} />} />;
  return <AdminErrorScreen error={error} />;
}

function AdminErrorScreen({ error }: { error: unknown }) {

  /**
   * Read from the root loader, not `process.env`.
   *
   * An error boundary replaces the component that threw, so this one renders
   * when the shell's own loader has failed and `useLoaderData` is unavailable.
   * The root loader still succeeds in that case, and it resolves the key on the
   * server. Reading `process.env` here would throw `ReferenceError` in the
   * browser, so the boundary would crash a second time and the merchant would
   * get React Router's default page instead of the message below.
   */
  const root = useRouteLoaderData<typeof rootLoader>("root");
  // The shell's own data is gone here, so the root loader's language is the
  // best available: it ignores the saved preference but honours `?lng=`,
  // Shopify's `locale` and `Accept-Language`.
  const t = createTranslator(root?.language ?? DEFAULT_LANGUAGE);

  // `guarded()` loaders throw `{ reference, hint }`; show the hint, not "500".
  const failure =
    isRouteErrorResponse(error) && typeof error.data === "object" && error.data !== null
      ? (error.data as { reference?: unknown; hint?: unknown })
      : null;
  const detail = typeof failure?.hint === "string"
    ? failure.hint
    : isShopifyAuthResponse(error)
    ? t("errors.session_reload")
    : isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : t("errors.generic");

  /**
   * Navigate via React Router so App Bridge intercepts the navigation and
   * keeps the embedded context (host param, iframe state) intact.
   *
   * `<s-button href="/app">` does a full-page navigation that strips the
   * `?host=` param Shopify requires. Without it, the embedded iframe lands on
   * `/app` without a session token, Shopify redirects to OAuth, and the
   * merchant sees a blank panel — the exact symptom the button exists to fix.
   */
  const navigate = useNavigate();
  const location = useLocation();

  // The mail body carries the page and a short reference, never a stack trace.
  const supportPage = typeof failure?.reference === "string"
    ? `${location.pathname} (${failure.reference})`
    : location.pathname;

  return (
    <AppProvider apiKey={root?.apiKey ?? ""}>
      <s-page>
        <SupportIconButton
          slot="secondary-actions"
          version={APP_VERSION}
          page={supportPage}
        />
        <s-section heading={t("errors.boundary_title")}>
          <s-stack gap="base">
            <s-text>{detail}</s-text>
            {typeof failure?.reference === "string" ? (
              <s-text color="subdued" fontSize="small">
                {t("errors.reference", { reference: failure.reference })}
              </s-text>
            ) : null}
            <s-stack direction="inline" gap="small">
              <s-button type="button" variant="primary" onClick={() => navigate("/app")}>
                {t("errors.not_found_cta")}
              </s-button>
              <SupportIconButton version={APP_VERSION} page={supportPage} />
            </s-stack>
          </s-stack>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
