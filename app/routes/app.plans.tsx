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
import { effectivePlan, evaluateCap, isPlanKey, PLAN_ORDER, planFor, PLANS } from "~/lib/plans";
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

export const meta: MetaFunction = () => [{ title: "Plans — SourceTrac" }];

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

  return {
    activePlan,
    used,
    cap: evaluateCap(activePlan, used),
    subscriptionGid: shop.subscriptionGid,
    plans: PLAN_ORDER.map((key) => {
      const plan = PLANS[key];
      return {
        key,
        name: plan.name,
        price: plan.priceMinor === 0 ? "Free" : `${formatMoney(plan.priceMinor, plan.currencyCode)}/month`,
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
async function cancelActiveSubscription(params: { shopDomain: string; accessToken: string }) {
  let subscriptions: Awaited<ReturnType<typeof fetchActiveSubscriptions>>;
  try {
    subscriptions = await fetchActiveSubscriptions(params);
  } catch {
    return {
      ok: false as const,
      message: "We could not reach Shopify to find your subscription. Please try again in a moment.",
    };
  }

  const active = activeSourceTracSubscription(subscriptions);
  if (!active) return { ok: true as const, message: "You are already on the Free plan." };

  const result = await cancelSubscription({ ...params, subscriptionGid: active.id });
  if (!result.ok) {
    return { ok: false as const, message: `Shopify could not cancel the subscription: ${result.error}` };
  }

  // Collection continues on the free cap rather than stopping; the webhook
  // moves the stored plan.
  return {
    ok: true as const,
    message: "Subscription cancelled. You are back on the Free plan with 50 responses a month.",
  };
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
    return {
      ok: false as const,
      message: "We could not reach Shopify to manage billing. Reopen the app from Shopify admin and try again.",
    };
  }

  if (intent === "subscribe") {
    const plan = String(form.get("plan") ?? "");
    if (!isPlanKey(plan)) return { ok: false as const, message: "That plan is not available." };

    if (plan === "free") {
      return cancelActiveSubscription({ shopDomain: shop.shopDomain, accessToken });
    }

    const result = await createSubscription({ shopDomain: shop.shopDomain, accessToken, plan });

    if (!result.ok) {
      return {
        ok: false as const,
        message: `Shopify could not start the subscription: ${result.error}`,
      };
    }

    // Shopify asks the merchant to approve the charge. We do not assume success
    // here — the app_subscriptions/update webhook confirms it.
    if (result.confirmationUrl) return redirect(result.confirmationUrl, { target: "_top" });

    return {
      ok: true as const,
      message: "Subscription created. If you were not sent to a confirmation page, check your Shopify admin billing page.",
    };
  }

  if (intent === "cancel") {
    return cancelActiveSubscription({ shopDomain: shop.shopDomain, accessToken });
  }

  return { ok: false as const, message: "Unknown action." };
});

export default function Plans() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const current = planFor(data.activePlan);

  return (
    <s-stack gap="base">
      <s-section heading="Plans" subheading="You are billed through Shopify. Cancel any time." padding="none" />

      {result ? (
        <Banner tone={result.ok ? "success" : "critical"} heading={result.ok ? "Done" : "Something went wrong"}>
          <s-text>{result.message}</s-text>
        </Banner>
      ) : null}

      <Banner tone="info" heading={`You are on ${current.name}`}>
        {data.cap.cap === null
          ? "Unlimited responses. Nothing is capped."
          : `${data.cap.used} of ${data.cap.cap} responses used this month.`}
      </Banner>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
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
                  <s-text type="strong">{plan.name}</s-text>
                  <s-heading>{plan.price}</s-heading>
                  {isCurrent ? <s-badge tone="info">Current plan</s-badge> : null}
                </s-stack>

                <s-unordered-list>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </s-unordered-list>

                {/* One primary action per card. */}
                {isCurrent ? (
                  data.activePlan === "free" ? (
                    <s-text color="subdued" fontSize="small">
                      You are on the free plan.
                    </s-text>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="cancel" />
                      <input type="hidden" name="subscriptionGid" value={data.subscriptionGid ?? ""} />
                      <s-button type="submit" variant="tertiary" loading={busy}>
                        Cancel subscription
                      </s-button>
                    </Form>
                  )
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="subscribe" />
                    <input type="hidden" name="plan" value={plan.key} />
                    <s-button type="submit" variant="primary" loading={busy}>
                      {plan.key === "free" ? "Switch to Free" : `Upgrade to ${plan.name}`}
                    </s-button>
                  </Form>
                )}
              </s-stack>
            </s-box>
          );
        })}
      </s-grid>

      <Panel title="How billing works">
        <s-text>
          Charges appear on your Shopify invoice alongside your other app subscriptions. SourceTrac
          never stores your card details — Shopify handles the payment and tells us when a
          subscription starts, changes or ends.
        </s-text>
      </Panel>
    </s-stack>
  );
}