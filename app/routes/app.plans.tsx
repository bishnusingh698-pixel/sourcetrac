import { useEffect, useState, type ReactNode } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { isShopifyConfirmationUrl } from "~/lib/billing-redirect";
import { createSubscription, cancelSubscription, cycleOf, isBillingNotEnabled } from "~/lib/billing.server";
import { logger } from "~/lib/logger";
import {
  effectivePlan,
  evaluateCap,
  FREE_RESPONSE_CAP,
  isBillingCycle,
  isPlanKey,
  PLAN_ORDER,
  planFor,
  PLANS,
  YEARLY_DISCOUNT_PERCENT,
  yearlySavingMinor,
  type BillingCycle,
} from "~/lib/plans";
import { formatMoney } from "~/lib/money";
import { getUsageCount } from "~/lib/responses.server";
import {
  activeSourceTracSubscription,
  fetchActiveSubscriptions,
  needsPlanSync,
  paidPlanFromSubscriptions,
  testChargesAllowed,
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

export const handle = { titleKey: "plans.title" };

/**
 * Action results carry a translation key rather than English. The action cannot
 * know which language the page is in, so the component translates.
 */
type Result = { ok: boolean; message: I18nText; confirmationUrl?: string };
const result = (ok: boolean, key: string, params?: I18nText["params"]): Result => ({
  ok,
  message: { key, params },
});

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const used = await getUsageCount(shop.id);
  const locale = intlLocaleFor(resolveAdminLanguage(request, shop.language, shop.adminLocale));
  const requestedCycle = new URL(request.url).searchParams.get("cycle");

  // Reconcile from Shopify rather than trusting our own column, so a charge
  // approved or cancelled outside the app is reflected here immediately.
  let activePlan = effectivePlan(shop);
  let synced = false;
  // The live charge's cycle, when Shopify answered, so the page opens on it.
  // Null when Shopify could not be asked: guessing "monthly" told a yearly
  // subscriber they paid monthly and offered to switch them to yearly.
  let activeCycle: BillingCycle | null = null;
  if (session.accessToken) {
    try {
      const subscriptions = await fetchActiveSubscriptions({
        shopDomain: shop.shopDomain,
        accessToken: session.accessToken,
      });
      const allowTest = await testChargesAllowed(shop.shopDomain, session.accessToken);
      const paid = paidPlanFromSubscriptions(subscriptions, { allowTest });
      const live = activeSourceTracSubscription(subscriptions, { allowTest });
      const reconciled: "free" | "growth" | "scale" = paid ?? "free";
      activeCycle = cycleOf(live);
      if (needsPlanSync(shop, reconciled)) {
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
        synced = true;
      }
      // Shown only once stored: if the write above failed, the page keeps
      // showing the plan that is actually enforced.
      activePlan = reconciled;
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
    // The shell loader ran in parallel with this one and read the old plan, so
    // the toolbar showed "Free" above "You're on Growth" after a billing
    // return. The component revalidates once when this is true.
    synced,
    used,
    cap: evaluateCap(activePlan, used),
    activeCycle,
    // The cycle the cards show: the URL's choice, else the merchant's own.
    cycle: isBillingCycle(requestedCycle) ? requestedCycle : (activeCycle ?? "monthly"),
    discountPercent: YEARLY_DISCOUNT_PERCENT,
    // The biggest yearly saving, for the badge on the Monthly / Yearly switch.
    maxYearlySaving: formatMoney(
      Math.max(...PLAN_ORDER.map((key) => yearlySavingMinor(PLANS[key]))),
      PLANS.scale.currencyCode,
      locale,
    ),
    plans: PLAN_ORDER.map((key) => {
      const plan = PLANS[key];
      const free = plan.priceMinor === 0;
      return {
        key,
        // null for the free plan: the component renders the translated "Free".
        monthly: free ? null : formatMoney(plan.priceMinor, plan.currencyCode, locale),
        yearly: free ? null : formatMoney(plan.yearlyPriceMinor, plan.currencyCode, locale),
        // What the yearly price works out to per month, rounded down so the
        // figure is never more than the merchant actually pays.
        yearlyPerMonth: free
          ? null
          : formatMoney(Math.floor(plan.yearlyPriceMinor / 12), plan.currencyCode, locale),
        // Twelve monthly payments minus the yearly price: the exact amount a
        // year of yearly billing saves, derived rather than typed in.
        yearlySaving: free ? null : formatMoney(yearlySavingMinor(plan), plan.currencyCode, locale),
        features: plan.features,
      };
    }),
  };
});

/**
 * Reading the subscriptions failed. Shopify refuses that read with the same
 * "public distribution" error as a new charge, so an app not yet set to Public
 * gets the message that says where to fix it. Anything else shows Shopify's
 * own error, so the cause can be read off the page without opening the logs.
 */
function lookupFailed(error: unknown): Result {
  const message = error instanceof Error ? error.message : String(error);
  return isBillingNotEnabled(message)
    ? result(false, "plans.msg_billing_not_enabled")
    : result(false, "plans.msg_lookup_failed", { error: message || "—" });
}

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
  } catch (error) {
    return lookupFailed(error);
  }

  const active = activeSourceTracSubscription(subscriptions, {
    allowTest: await testChargesAllowed(params.shopDomain, params.accessToken),
  });
  if (!active) return result(true, "plans.msg_already_free");

  const cancelled = await cancelSubscription({ ...params, subscriptionGid: active.id });
  if (!cancelled.ok) {
    if (isBillingNotEnabled(cancelled.error)) return result(false, "plans.msg_billing_not_enabled");
    return result(false, "plans.msg_cancel_failed", { error: cancelled.error ?? "—" });
  }

  // Collection continues on the free cap rather than stopping; the webhook
  // moves the stored plan.
  return result(true, "plans.msg_cancelled", { cap: FREE_RESPONSE_CAP });
}

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  // Shopify's charge-approval page refuses to render inside the embedded
  // iframe, so a new charge's URL goes back to the page, which opens it in the
  // top frame (`isShopifyConfirmationUrl`).
  const { session } = await authenticate.admin(request);
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

    const rawCycle = String(form.get("cycle") ?? "monthly");
    const cycle: BillingCycle = isBillingCycle(rawCycle) ? rawCycle : "monthly";
    const allowTest = await testChargesAllowed(shop.shopDomain, accessToken);

    // Choosing the plan and cycle already held would create a second,
    // duplicate charge for the merchant to approve.
    try {
      const subscriptions = await fetchActiveSubscriptions({ shopDomain: shop.shopDomain, accessToken });
      const current = paidPlanFromSubscriptions(subscriptions, { allowTest });
      const live = activeSourceTracSubscription(subscriptions, { allowTest });
      if (current === plan && cycleOf(live) === cycle) {
        return result(true, "plans.msg_already_on_plan");
      }
    } catch (error) {
      return lookupFailed(error);
    }

    const created = await createSubscription({
      shopDomain: shop.shopDomain,
      accessToken,
      plan,
      cycle,
      test: allowTest,
    });

    if (!created.ok) {
      if (isBillingNotEnabled(created.error)) return result(false, "plans.msg_billing_not_enabled");
      return result(false, "plans.msg_subscribe_failed", { error: created.error });
    }

    // Shopify asks the merchant to approve the charge. We do not assume success
    // here — the app_subscriptions/update webhook confirms it. The page opens
    // the approval page in the top frame (see `isShopifyConfirmationUrl`).
    if (isShopifyConfirmationUrl(created.confirmationUrl)) {
      return { ...result(true, "plans.msg_opening_approval"), confirmationUrl: created.confirmationUrl };
    }

    // Without a confirmation URL there is nothing the merchant can approve.
    logger.warn("billing_no_confirmation_url", { shop_domain: shop.shopDomain, plan, cycle });
    return result(false, "plans.msg_subscribe_failed", { error: "—" });
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
  const { revalidate } = useRevalidator();

  // The charge's approval page cannot load inside the admin iframe.
  const confirmationUrl = outcome?.confirmationUrl;
  useEffect(() => {
    if (isShopifyConfirmationUrl(confirmationUrl)) window.open(confirmationUrl, "_top");
  }, [confirmationUrl]);

  // Refresh the shell (plan badge, usage, cap banner) once this page has
  // corrected the stored plan. Keyed on `synced` alone, so it fires once.
  useEffect(() => {
    if (data.synced) void revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.synced]);
  // Only the card that was submitted shows a spinner; the others stay usable
  // to read. `formData` identifies which form is in flight.
  const pendingPlan = navigation.state !== "idle" ? String(navigation.formData?.get("plan") ?? "cancel") : null;

  const current = planFor(data.activePlan);
  const yearly = data.cycle === "yearly";
  const currentName = t(`plans.${current.key}`);

  return (
    <s-stack gap="base">
      {outcome ? (
        <Banner
          tone={outcome.ok ? "success" : "critical"}
          heading={outcome.ok ? t("common.done") : t("errors.boundary_title")}
        >
          <s-text>{t(outcome.message.key, outcome.message.params)}</s-text>
        </Banner>
      ) : null}

      {/* Where the merchant stands, in one card: plan, cycle and usage. */}
      <s-section>
        <s-query-container>
          <s-grid gridTemplateColumns="@container (inline-size > 560px) minmax(0, 1fr) auto, minmax(0, 1fr)" gap="base" alignItems="center">
            <s-stack gap="small-200">
              <s-text color="subdued" fontSize="small">
                {t("plans.current_label")}
              </s-text>
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-heading>{currentName}</s-heading>
                {current.key === "free" || data.activeCycle === null ? null : (
                  <s-badge tone="success">
                    {data.activeCycle === "yearly" ? t("plans.billed_yearly") : t("plans.billed_monthly")}
                  </s-badge>
                )}
              </s-stack>
              <s-text color="subdued">
                {data.cap.cap === null
                  ? t("plans.unlimited_help")
                  : t("plans.usage_aria", { count: data.cap.used, cap: data.cap.cap })}
              </s-text>
            </s-stack>
            {data.cap.cap === null ? null : (
              <s-box minInlineSize="0">
                <s-progress
                  value={Math.min(data.cap.used, data.cap.cap)}
                  max={data.cap.cap}
                  tone={data.cap.atCap ? "critical" : data.cap.atWarning ? "warning" : "success"}
                  accessibilityLabel={t("plans.usage_aria", { count: data.cap.used, cap: data.cap.cap })}
                />
              </s-box>
            )}
          </s-grid>
        </s-query-container>
      </s-section>

      {/* Monthly / yearly switch. A link, so the choice survives a refresh. */}
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button-group accessibilityLabel={t("plans.cycle_label")}>
          <s-button href="/app/plans?cycle=monthly" variant={yearly ? "secondary" : "primary"}>
            {t("plans.cycle_monthly")}
          </s-button>
          <s-button href="/app/plans?cycle=yearly" variant={yearly ? "primary" : "secondary"}>
            {t("plans.cycle_yearly")}
          </s-button>
        </s-button-group>
        <s-badge tone="success">{t("plans.save_up_to", { amount: data.maxYearlySaving })}</s-badge>
      </s-stack>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" gap="base">
        {data.plans.map((plan) => {
          // An unknown cycle still marks the plan as current on both views,
          // so the page never offers to "switch" a merchant to what they have.
          const isCurrent =
            plan.key === data.activePlan &&
            (plan.key === "free" || data.activeCycle === null || data.activeCycle === data.cycle);
          const recommended = plan.key === "growth";
          const name = t(`plans.${plan.key}`);
          return (
            <s-box
              key={plan.key}
              padding="base"
              border={isCurrent || recommended ? "base strong" : "base"}
              borderRadius="large"
              background={isCurrent ? "subdued" : "base"}
            >
              <s-stack gap="base">
                <s-stack gap="small-200">
                  <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                    <s-text type="strong">{name}</s-text>
                    {isCurrent ? (
                      <s-badge tone="info">{t("plans.current_badge")}</s-badge>
                    ) : recommended ? (
                      <s-badge tone="success" icon="star">
                        {t("plans.recommended")}
                      </s-badge>
                    ) : null}
                  </s-stack>
                  <s-text color="subdued">{t(`plans.best_for_${plan.key}`)}</s-text>
                </s-stack>

                <PlanPrice plan={plan} yearly={yearly} percent={data.discountPercent} t={t} />

                <s-divider />

                {/* What the merchant gets, one outcome per line. */}
                <s-stack gap="small">
                  {plan.features.map((feature) => (
                    <s-grid key={feature.key} gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
                      <s-icon type="check-circle" tone="success" size="small" />
                      <s-text>{t(feature.key, feature.params)}</s-text>
                    </s-grid>
                  ))}
                </s-stack>

                {/* One primary action per card. Anything that ends a paid
                    subscription asks for confirmation first: on a phone a
                    stray tap is easy, and a cancellation is not undoable. */}
                {isCurrent ? (
                  data.activePlan === "free" ? (
                    <s-text color="subdued" fontSize="small">
                      {t("plans.on_free")}
                    </s-text>
                  ) : (
                    <ConfirmCancel label={t("plans.cancel_confirm")} busy={pendingPlan === "cancel"} t={t}>
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
                    <input type="hidden" name="cycle" value={data.cycle} />
                    <s-button
                      type="submit"
                      variant={recommended ? "primary" : "secondary"}
                      inlineSize="fill"
                      loading={pendingPlan === plan.key}
                    >
                      {plan.key === data.activePlan
                        ? yearly
                          ? t("plans.switch_yearly")
                          : t("plans.switch_monthly")
                        : t("plans.choose_plan", { plan: name })}
                    </s-button>
                  </Form>
                )}
              </s-stack>
            </s-box>
          );
        })}
      </s-grid>

      <s-stack direction="inline" gap="base" alignItems="center">
        {(["reassure_cancel", "reassure_shopify", "reassure_data"] as const).map((key) => (
          <s-stack key={key} direction="inline" gap="small-200" alignItems="center">
            <s-icon type="check" tone="success" size="small" />
            <s-text color="subdued" fontSize="small">
              {t(`plans.${key}`)}
            </s-text>
          </s-stack>
        ))}
      </s-stack>

      <Panel title={t("plans.billing_title")}>
        <s-stack gap="small">
          <s-text>{t("plans.billing_body")}</s-text>
          <s-text color="subdued">{t("plans.yearly_note", { percent: data.discountPercent })}</s-text>
        </s-stack>
      </Panel>
    </s-stack>
  );
}
type PlanCard = ReturnType<typeof useLoaderData<typeof loader>>["plans"][number];

/**
 * The price block of a plan card.
 *
 * Yearly leads with what it costs per month, next to the monthly price struck
 * through, so the two cycles compare like for like; the amount actually billed
 * once a year and the saving in money follow, because a merchant decides on
 * the charge they will see on their invoice, not on a percentage. Monthly shows
 * the yearly option as one quiet line, so the saving is visible without
 * switching.
 */
function PlanPrice({
  plan,
  yearly,
  percent,
  t,
}: {
  plan: PlanCard;
  yearly: boolean;
  percent: number;
  t: ReturnType<typeof useAdminI18n>["t"];
}) {
  if (plan.monthly === null) {
    return (
      <s-stack gap="small-200">
        <s-text fontSize="large-100" fontWeight="bold">
          {t("plans.free")}
        </s-text>
        <s-text color="subdued" fontSize="small">
          {t("plans.forever")}
        </s-text>
      </s-stack>
    );
  }

  if (!yearly) {
    return (
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="baseline">
          <s-text fontSize="large-100" fontWeight="bold" fontVariantNumeric="tabular-nums">
            {plan.monthly}
          </s-text>
          <s-text color="subdued">{t("plans.per_month")}</s-text>
        </s-stack>
        <s-text color="subdued" fontSize="small">
          {t("plans.yearly_nudge", { price: plan.yearlyPerMonth ?? "", amount: plan.yearlySaving ?? "" })}
        </s-text>
      </s-stack>
    );
  }

  return (
    <s-stack gap="small-200">
      <s-stack direction="inline" gap="small-200" alignItems="baseline">
        <s-text fontSize="large-100" fontWeight="bold" fontVariantNumeric="tabular-nums">
          {plan.yearlyPerMonth}
        </s-text>
        <s-text color="subdued">{t("plans.per_month")}</s-text>
        <s-text color="subdued" fontVariantNumeric="tabular-nums">
          <del className="st-was-price">
            <span className="st-visually-hidden">{t("plans.was_price")} </span>
            {plan.monthly}
          </del>
        </s-text>
      </s-stack>
      <s-text color="subdued" fontSize="small">
        {t("plans.billed_yearly_total", { price: plan.yearly ?? "" })}
      </s-text>
      <s-stack direction="inline" gap="small">
        <s-badge tone="success" icon="discount">
          {t("plans.save_amount", { amount: plan.yearlySaving ?? "", percent })}
        </s-badge>
      </s-stack>
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
