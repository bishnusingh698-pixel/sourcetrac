import { NavLink, Outlet, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { Banner } from "~/components/admin-ui";
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

const NAV = [
  { to: "/app", label: "Dashboard", icon: "home", end: true },
  { to: "/app/onboarding", label: "Get started", icon: "check", end: false },
  { to: "/app/settings", label: "Settings", icon: "settings", end: false },
  { to: "/app/export", label: "Export", icon: "download", end: false },
  { to: "/app/plans", label: "Plans", icon: "money", end: false },
  { to: "/app/help", label: "Help", icon: "question", end: false },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await requireShop(session.shop);
  const used = await getUsageCount(shop.id);

  return {
    shop,
    used,
    plan: planFor(shop.plan),
    cap: evaluateCap(shop.plan, used),
  };
};

export default function AdminLayout() {
  const { shop, plan, cap } = useLoaderData<typeof loader>();

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
              <nav aria-label="Main">
                <s-unordered-list>
                  {NAV.map((item) => (
                    <li key={item.to}>
                      <NavLink to={item.to} end={item.end}>
                        {({ isActive }) => (
                          <s-text type={isActive ? "strong" : "generic"}>{item.label}</s-text>
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
                    accessibilityLabel={`${cap.used} of ${cap.cap} responses used this month`}
                  />
                ) : null}
                <s-text color="subdued" fontSize="small">
                  {cap.cap === null
                    ? "Unlimited responses"
                    : `${cap.used} of ${cap.cap} responses this month`}
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
                <Banner tone="warning" heading="SourceTrac is not available on your plan">
                  The survey needs a paid Shopify plan. It cannot appear on your checkout or
                  order status page while your store is on Starter. Upgrade your Shopify plan to
                  start collecting answers.
                </Banner>
              ) : cap.atWarning && !cap.atCap ? (
                <Banner tone="warning" heading={`You have used ${cap.used} of your ${cap.cap} responses`}>
                  <s-stack gap="small">
                    <s-text>
                      Answers are still being collected. Once you reach {cap.cap} this month, new
                      answers are saved but paused from your dashboard totals.
                    </s-text>
                    <s-button href="/app/plans" variant="primary">
                      Upgrade plan
                    </s-button>
                  </s-stack>
                </Banner>
              ) : cap.atCap ? (
                <Banner tone="critical" heading="Your free response limit is reached">
                  <s-stack gap="small">
                    <s-text>
                      New answers are still saved, but they are paused from your dashboard until
                      you upgrade. Nothing is lost.
                    </s-text>
                    <s-button href="/app/plans" variant="primary">
                      Upgrade to keep collecting
                    </s-button>
                  </s-stack>
                </Banner>
              ) : null}

              <Outlet />
            </s-stack>
          </s-box>
        </s-grid-item>
      </s-grid>
    </s-page>
  );
}