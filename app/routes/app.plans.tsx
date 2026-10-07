import { useState, type ReactNode } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { createSubscription, cancelSubscription } from "~/lib/billing.server";
import { logger } from "~/lib/logger";
import { effectivePlan, evaluateCap, FREE_RESPONSE_CAP, isPlanKey, PLAN_ORDER, planFor, PLANS } from "~/lib/plans";
import { formatMoney } from "~/lib/money";
import { getUsageCount } from "~/lib/responses.server";
import {
  activeSourceTracSubscription,
  fetchActiveSubscriptions,
  paidPlanFromSubscriptions,
} from "~/lib/billing.server";
import { getAccessToken, setPlan } from "~/lib/shop.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import type { I18nText } from "~/lib/settings";
import { authenticate } from "~/shopify.server";

/**
 * Plans and billing.
 *
 * One primary action per card: subscribe or cancel.
 *
 * Billing uses the Admin API recurring-charge flow only. `createSubscription`
 * returns a `confirmationUrl`, and we redirect the merchant to it — Shopify owns
 * the approval screen, so the card details never touch our server. The
 * `app_subscriptions/update` webhook is what actually marks the plan active, not
 * this action.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "plans.title");

/**
 * Action results carry a translation key rather than English. The action cannot
 * know which language the page is in, so the component translates.
 */
type Result = { ok: boolean; message: I18nText };
const result = (ok: boolean, key: string, params?: I18nText["params"]): Result => ({
  ok,
  message: { key, params },
});

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const used = await getUsageCount(shop.id);

  // Reconcile from Shopify rather than trusting our own column, so a charge
  // approved or cancelled outside the app is reflected here immediately.
  let activePlan = effectivePlan(shop);
  if (session.accessToken) {
    try {
      const subscriptions = await fetchActiveSubscriptions({
        shopDomain: shop.shopDomain,
        accessToken: session.accessToken,
      });
      const paid = paidPlanFromSubscriptions(subscriptions);
      const live = activeSourceTracSubscription(subscriptions);
      const reconciled: "free" | "growth" | "scale" = paid ?? "free";
      activePlan = reconciled;
      if (reconciled !== shop.plan) {
        // `planStatus` records whether a charge is actually live, and the
        // `app_subscriptions/*` webhooks own it. This page only sees
        // `activeSubscriptions`, so finding none means the charge is no longer
        // active -- never that it is. Stamping "active" here (the old
        // behaviour) rewrote a cancelled or expired subscription back to
        // active and destroyed the record of the cancellation.
        //
        // `expired` is the same default `normaliseSubscriptionStatus` uses when
        // a status is unrecognised, so this agrees with the webhook path.
        // Collecting behaviour is unaffected either way: `api.responses`
        // resolves the effective plan as `planStatusIsCollecting(planStatus) ?
        // plan : "free"`, and `plan` is now free.
        await setPlan(shop.id, {
          plan: reconciled,
          planStatus: reconciled === "free" ? "expired" : "active",
          subscriptionGid: live?.id ?? shop.subscriptionGid,
        });
      }
    } catch (error) {
      // Fall back to the stored plan rather than blocking the page. The webhook
      // will correct it on the next charge change.
      logger.warn("plans_reconcile_failed", {
        shop_domain: shop.shopDomain,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language));

  return {
    activePlan,
    used,
    cap: evaluateCap(activePlan, used),
    plans: PLAN_ORDER.map((key) => {
      const plan = PLANS[key];
      return {
        key,
        // null for the free plan: the component renders the translated "Free".
        price: plan.priceMinor === 0 ? null : formatMoney(plan.priceMinor, plan.currencyCode, locale),
        features: plan.features,
      };
    }),
  };
});

/**
 * Cancel whatever live SourceTrac subscription Shopify reports.
 *
 * Resolved from Shopify rather than from our stored `subscriptionGid`, which can
 * be missing or stale. Also what "Switch to Free" does: the Free plan is the
 * absence of a paid charge, not a $0 charge.
 */
async function cancelActiveSubscription(params: { shopDomain: string; accessToken: string }): Promise<Result> {
  let subscriptions: Awaited<ReturnType<typeof fetchActiveSubscriptions>>;
  try {
    subscriptions = await fetchActiveSubscriptions(params);
  } catch {
    return result(false, "plans.msg_lookup_failed");
  }

  const active = activeSourceTracSubscription(subscriptions);
  if (!active) return result(true, "plans.msg_already_free");

  const cancelled = await cancelSubscription({ ...params, subscriptionGid: active.id });
  if (!cancelled.ok) {
    return result(false, "plans.msg_cancel_failed", { error: cancelled.error ?? "—" });
  }

  // Collection continues on the free cap rather than stopping; the webhook
  // moves the stored plan.
  return result(true, "plans.msg_cancelled", { cap: FREE_RESPONSE_CAP });
}

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  // The library's `redirect` breaks out of the embedded iframe. Shopify's
  // charge-approval page refuses to render inside it, so a plain redirect
  // left the merchant on a blank frame and no upgrade could ever complete.
  const { session, redirect } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Fall back to the stored token so billing still works if the admin session
  // was created as an online-only session.
  const accessToken = session.accessToken ?? (await getAccessToken(shop.id));
  if (!accessToken) {
    return result(false, "plans.msg_shopify_unreachable");
  }

  if (intent === "subscribe") {
    const plan = String(form.get("plan") ?? "");
    if (!isPlanKey(plan)) return result(false, "plans.msg_plan_unavailable");

    if (plan === "free") {
      return cancelActiveSubscription({ shopDomain: shop.shopDomain, accessToken });
    }

    const created = await createSubscription({ shopDomain: shop.shopDomain, accessToken, plan });

    if (!created.ok) {
      return result(false, "plans.msg_subscribe_failed", { error: created.error });
    }

    // Shopify asks the merchant to approve the charge. We do not assume success
    // here — the app_subscriptions/update webhook confirms it.
    if (created.confirmationUrl) return redirect(created.confirmationUrl, { target: "_top" });

    return result(true, "plans.msg_subscription_created");
  }

  if (intent === "cancel") {
    return cancelActiveSubscription({ shopDomain: shop.shopDomain, accessToken });
  }

  return result(false, "errors.generic");
});

export default function Plans() {
  const data = useLoaderData<typeof loader>();
  const outcome = useActionData<typeof action>();
  const navigation = useNavigation();
  const { t } = useAdminI18n();
  // Only the card that was submitted shows a spinner; the others stay usable
  // to read. `formData` identifies which form is in flight.
  const pendingPlan = navigation.state !== "idle" ? String(navigation.formData?.get("plan") ?? "cancel") : null;

  const current = planFor(data.activePlan);

  return (
    <s-stack gap="base">
      <s-section heading={t("plans.title")} subheading={t("plans.subtitle")} padding="none" />

      {outcome ? (
        <Banner
          tone={outcome.ok ? "success" : "critical"}
          heading={outcome.ok ? t("common.done") : t("errors.boundary_title")}
        >
          <s-text>{t(outcome.message.key, outcome.message.params)}</s-text>
        </Banner>
      ) : null}

      <Banner tone="info" heading={t("plans.current_banner", { plan: t(`plans.${current.key}`) })}>
        {data.cap.cap === null
          ? t("plans.unlimited")
          : t("plans.usage_aria", { count: data.cap.used, cap: data.cap.cap })}
      </Banner>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" gap="base">
        {data.plans.map((plan) => {
          const isCurrent = plan.key === data.activePlan;
          return (
            <s-box
              key={plan.key}
              padding="base"
              border={isCurrent ? "base" : "none"}
              borderRadius="base"
              background={isCurrent ? "subdued" : undefined}
            >
              <s-stack gap="base">
                <s-stack gap="small">
                  <s-text type="strong">{t(`plans.${plan.key}`)}</s-text>
                  <s-heading>{plan.price === null ? t("plans.free") : plan.price}</s-heading>
                  {plan.price === null ? null : (
                    <s-text color="subdued" fontSize="small">
                      {t("plans.per_month")}
                    </s-text>
                  )}
                  {isCurrent ? <s-badge tone="info">{t("plans.current_label")}</s-badge> : null}
                </s-stack>

                <s-unordered-list>
                  {plan.features.map((feature) => (
                    <li key={feature.key}>{t(feature.key, feature.params)}</li>
                  ))}
                </s-unordered-list>

                {/* One primary action per card. Anything that ends a paid
                    subscription asks for confirmation first: on a phone a
                    stray tap is easy, and a cancellation is not undoable. */}
                {isCurrent ? (
                  data.activePlan === "free" ? (
                    <s-text color="subdued" fontSize="small">
                      {t("plans.on_free")}
                    </s-text>
                  ) : (
                    <ConfirmCancel
                      label={t("plans.cancel_confirm")}
                      busy={pendingPlan === "cancel"}
                      t={t}
                    >
                      <input type="hidden" name="intent" value="cancel" />
                    </ConfirmCancel>
                  )
                ) : plan.key === "free" ? (
                  <ConfirmCancel label={t("plans.switch_free")} busy={pendingPlan === "free"} t={t}>
                    <input type="hidden" name="intent" value="subscribe" />
                    <input type="hidden" name="plan" value="free" />
                  </ConfirmCancel>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="subscribe" />
                    <input type="hidden" name="plan" value={plan.key} />
                    <s-button type="submit" variant="primary" loading={pendingPlan === plan.key}>
                      {t("plans.choose_plan", { plan: t(`plans.${plan.key}`) })}
                    </s-button>
                  </Form>
                )}
              </s-stack>
            </s-box>
          );
        })}
      </s-grid>

      <Panel title={t("plans.billing_title")}>
        <s-text>{t("plans.billing_body")}</s-text>
      </Panel>
    </s-stack>
  );
}
/**
 * A cancel/downgrade control that asks before submitting.
 *
 * The first tap only reveals the consequence and a confirm button; nothing is
 * posted until the merchant confirms. "Keep my plan" is the default-looking
 * escape so the safe choice is the easy one.
 */
function ConfirmCancel({
  label,
  busy,
  t,
  children,
}: {
  label: string;
  busy: boolean;
  t: ReturnType<typeof useAdminI18n>["t"];
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <div>
        <s-button type="button" variant="secondary" onClick={() => setAsking(true)}>
          {label}
        </s-button>
      </div>
    );
  }

  return (
    <s-box padding="small" border="base" borderRadius="base">
      <Form method="post">
        {children}
        <s-stack gap="small">
          <s-text type="strong">{t("plans.cancel_title")}</s-text>
          <s-text color="subdued">{t("plans.cancel_body")}</s-text>
          <s-stack direction="inline" gap="small">
            <s-button type="button" variant="primary" onClick={() => setAsking(false)}>
              {t("plans.keep_plan")}
            </s-button>
            <s-button type="submit" variant="secondary" tone="critical" loading={busy}>
              {label}
            </s-button>
          </s-stack>
        </s-stack>
      </Form>
    </s-box>
  );
}
