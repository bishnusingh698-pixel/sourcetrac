import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useNavigate,
  useRouteError,
  useRouteLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
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
import { LanguageForm } from "~/components/language-selector";
import {
  createTranslator,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
} from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { effectivePlan, evaluateCap, planFor } from "~/lib/plans";
import { getUsageCount } from "~/lib/responses.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { isShopifyAuthResponse } from "~/lib/shopify-boundary";

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
 * Pages registered in the Shopify admin's own navigation via `<s-app-nav>`.
 *
 * The label is an i18next key, not display text: this array is a module-level
 * constant shared by every request, so a translated string could never be
 * stored here without leaking one merchant's language into the next tenant's
 * page. Keys are resolved per render.
 *
 * The dashboard is not listed. It is the app's home (`rel="home"` below), so
 * Shopify opens it when the merchant clicks the app's name. Listing it as well
 * made it a separate "Dashboard" sub-page under the app.
 *
 * There is deliberately no in-frame sidebar any more. Shopify already renders
 * these links in its admin sidebar on desktop and in the app title menu on
 * phones; a second copy inside the iframe took a whole column, which on a
 * phone left the dashboard squeezed into the remaining sliver.
 */
const NAV = [
  { to: "/app/settings", key: "nav.settings" },
  { to: "/app/export", key: "nav.export" },
  { to: "/app/plans", key: "nav.plans" },
  { to: "/app/help", key: "nav.help" },
] as const;

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

  const language = resolveAdminLanguage(request, shop.language);

  return {
    /**
     * App Bridge needs the public Client ID on the client. This is the
     * publishable Partner Dashboard key, never the API secret.
     */
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    shop,
    used,
    plan: planFor(enforcedPlan),
    cap: evaluateCap(enforcedPlan, used),
    language,
    /**
     * Whether the language came from the merchant's own choice. When false the
     * dashboard's setup guide offers the full picker, detected value preselected.
     */
    hasExplicitLanguage: isSupportedLanguage(shop.language),
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

export default function AdminLayout() {
  const { apiKey, shop, plan, cap, language, hasExplicitLanguage } =
    useLoaderData<typeof loader>();
  const t = createTranslator(language);

  return (
    <AppProvider apiKey={apiKey}>
      {/* Shopify admin's own sidebar entries for this app. Without this the
          app shows no pages under its name in the admin navigation, so the
          survey editor is only reachable through the in-page menu below. */}
      <s-app-nav>
        <s-link href="/app" {...HOME_LINK}>
          {t("nav.dashboard")}
        </s-link>
        {NAV.map((item) => (
          <s-link key={item.to} href={item.to}>
            {t(item.key)}
          </s-link>
        ))}
      </s-app-nav>
      <s-page>
        <s-stack gap="base">
          {/*
            Toolbar: plan usage and the language switcher. A query container so
            the grid can respond to the width the admin actually gives the
            iframe, not the device viewport: on a phone the two halves stack,
            on desktop they sit on one line.
          */}
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size > 560px) 1fr minmax(12rem, 16rem), 1fr"
              gap="small"
              alignItems="center"
            >
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone={cap.atCap ? "critical" : cap.atWarning ? "warning" : "neutral"}>
                  {t(`plans.${plan.key}`)}
                </s-badge>
                <s-text color="subdued" fontSize="small" fontVariantNumeric="tabular-nums">
                  {cap.cap === null
                    ? t("plans.unlimited")
                    : t("plans.usage", { count: cap.used, cap: cap.cap })}
                </s-text>
              </s-stack>
              <LanguageForm language={language} detected={!hasExplicitLanguage} inline />
            </s-grid>
          </s-query-container>

          {/* Plan-blocked takes precedence: the survey cannot appear at all,
              so explaining the cap would be a distraction. */}
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
        </s-stack>
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
  if (isShopifyAuthResponse(error)) return boundary.error(error);
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

  return (
    <AppProvider apiKey={root?.apiKey ?? ""}>
      <s-page>
        <s-section heading={t("errors.boundary_title")}>
          <s-stack gap="base">
            <s-text>{detail}</s-text>
            {typeof failure?.reference === "string" ? (
              <s-text color="subdued" fontSize="small">
                {t("errors.reference", { reference: failure.reference })}
              </s-text>
            ) : null}
            <s-button type="button" variant="primary" onClick={() => navigate("/app")}>
              {t("errors.not_found_cta")}
            </s-button>
          </s-stack>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
