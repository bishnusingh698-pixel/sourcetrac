import { env } from "./env";
import { logger } from "./logger";
import {
  BILLING_INTERVALS,
  PLANS,
  cycleFromInterval,
  isPlanKey,
  planPriceAmount,
  subscriptionName,
  type BillingCycle,
  type PlanKey,
} from "./plans";
import { PLANS_QUERY, shopifyGraphql } from "./shopify-graphql.server";
import { fetchIsDevelopmentStore } from "./shopify-rest.server";

/**
 * Shopify Billing API.
 *
 * Managed app pricing stopped applying to new recurring charges on
 * 2026-04-28, so SourceTrac uses the Billing API directly and keeps
 * shopify.app.toml free of `[billing]`. The merchant still sees the charge on
 * their Shopify account and can approve/decline it there — same UX, we just
 * own the plan definition. See docs/01-verification-report.md §A12.
 *
 * Docs: https://shopify.dev/docs/apps/recurring-billing/subscription-billing/offer-subscription-plan
 */

const CREATE_MUTATION = `#graphql
  mutation SourceTracCreateSubscription($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean!) {
    appSubscriptionCreate(
      name: $name,
      returnUrl: $returnUrl,
      test: $test,
      lineItems: $lineItems,
    ) {
      appSubscription {
        id
        status
        name
        test
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation SourceTracCancelSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type BillingError = { field: string[] | null; message: string };

/**
 * Shopify's refusal for an app whose distribution is not Public: "Apps without
 * a public distribution cannot use the Billing API". It is about the app's
 * setting in the Partner Dashboard, not the store, and no retry or store type
 * fixes it, so the Plans page says what to change instead of echoing Shopify.
 */
export function isBillingNotEnabled(error: string | undefined): boolean {
  return typeof error === "string" && /public distribution|cannot use the billing api/i.test(error);
}

function mapUserErrors(errors: BillingError[]): string {
  return errors.map((e) => e.message).join("; ") || "Unknown billing error";
}

export type SubscriptionResult =
  | { ok: true; subscriptionGid: string; confirmationUrl: string | null; test: boolean }
  | { ok: false; error: string; userErrors: BillingError[] };

/**
 * Where Shopify sends the merchant after they approve or decline a charge.
 *
 * It must be the app's page *inside the admin*. Shopify opens it top-level, so
 * a bare `${APP_URL}/app/plans` arrives with no `shop`, `host` or session
 * token: authentication cannot run and the merchant is stranded outside the
 * admin instead of seeing their new plan. The admin URL keyed by the client id
 * is the same one the auth library builds in `getEmbeddedAppUrl`.
 */
export function billingReturnUrl(shopDomain: string): string {
  const store = shopDomain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${encodeURIComponent(store)}/apps/${encodeURIComponent(
    env().SHOPIFY_API_KEY,
  )}/app/plans?billing=return`;
}

/**
 * Create a recurring charge. In development this is a test charge so the
 * merchant can approve and cancel repeatedly without being billed.
 */
export async function createSubscription(params: {
  shopDomain: string;
  accessToken: string;
  plan: PlanKey;
  /** Monthly unless the merchant chose yearly billing. */
  cycle?: BillingCycle;
  test?: boolean;
}): Promise<SubscriptionResult> {
  const definition = PLANS[params.plan];
  const cycle = params.cycle ?? "monthly";
  const returnUrl = billingReturnUrl(params.shopDomain);

  try {
    const response = await shopifyGraphql<{
      appSubscriptionCreate: {
        appSubscription: { id: string; status: string; name: string; test: boolean } | null;
        confirmationUrl: string | null;
        userErrors: BillingError[];
      };
    }>(params.shopDomain, params.accessToken, CREATE_MUTATION, {
      name: subscriptionName(params.plan, cycle),
      returnUrl,
      // A test charge outside production, and on a development store (the only
      // kind of charge such a store can approve; App Store review uses one).
      test: params.test ?? env().NODE_ENV !== "production",
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              // Major-unit decimal string ("4.99"), not minor units.
              price: { amount: planPriceAmount(params.plan, cycle), currencyCode: definition.currencyCode },
              interval: BILLING_INTERVALS[cycle],
            },
          },
        },
      ],
    },
    // Not idempotent: retrying after a 5xx that Shopify did process created a
    // second pending charge.
    { idempotent: false },
    );

    const payload = response.data.appSubscriptionCreate;

    if (payload.userErrors.length > 0) {
      logger.warn("billing_create_user_errors", { plan: params.plan, errors: payload.userErrors });
      return { ok: false, error: mapUserErrors(payload.userErrors), userErrors: payload.userErrors };
    }

    if (!payload.appSubscription) {
      return { ok: false, error: "Shopify did not return a subscription.", userErrors: [] };
    }

    return {
      ok: true,
      subscriptionGid: payload.appSubscription.id,
      confirmationUrl: payload.confirmationUrl,
      test: payload.appSubscription.test,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("billing_create_failed", { plan: params.plan, error_message: message });
    return { ok: false, error: message, userErrors: [] };
  }
}

export async function cancelSubscription(params: {
  shopDomain: string;
  accessToken: string;
  subscriptionGid: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await shopifyGraphql<{
      appSubscriptionCancel: {
        appSubscription: { id: string; status: string } | null;
        userErrors: BillingError[];
      };
    }>(params.shopDomain, params.accessToken, CANCEL_MUTATION, { id: params.subscriptionGid });

    const payload = response.data.appSubscriptionCancel;
    if (payload.userErrors.length > 0) {
      return { ok: false, error: mapUserErrors(payload.userErrors) };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("billing_cancel_failed", { error_message: message });
    return { ok: false, error: message };
  }
}

export type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  test: boolean;
  currentPeriodEnd: string | null;
  /** Billing cycle of the recurring line item; null when Shopify sent none. */
  cycle?: BillingCycle | null;
  /** Price per cycle as Shopify reports it (major units, e.g. "19.0"). */
  priceAmount?: string | null;
  currencyCode?: string | null;
};

type RawLineItem = {
  plan?: {
    pricingDetails?: {
      __typename?: string;
      interval?: string;
      price?: { amount?: string; currencyCode?: string };
    } | null;
  } | null;
};

/**
 * Read active subscriptions from Shopify. Used to reconcile on app load, so a
 * missed webhook cannot leave a merchant stuck on the wrong plan.
 */
export async function fetchActiveSubscriptions(params: {
  shopDomain: string;
  accessToken: string;
}): Promise<ActiveSubscription[]> {
  try {
    const response = await shopifyGraphql<{
      appInstallation: {
        activeSubscriptions: Array<{
          id: string;
          name: string;
          status: string;
          test: boolean;
          currentPeriodEnd: string | null;
          lineItems?: RawLineItem[] | null;
        }>;
      } | null;
    }>(params.shopDomain, params.accessToken, PLANS_QUERY);

    // No installation in the answer is not "no subscriptions": treating it so
    // downgraded a paying merchant to Free on a partial response.
    if (!response.data.appInstallation) throw new Error("Shopify returned no app installation.");
    return (response.data.appInstallation.activeSubscriptions ?? []).map(({ lineItems, ...subscription }) => {
      // The recurring line item carries the price and interval. A subscription
      // created before yearly billing existed is monthly, which is also what an
      // absent line item is read as by `cycleOf`.
      const recurring = (lineItems ?? [])
        .map((item) => item.plan?.pricingDetails)
        .find((details) => details?.__typename === "AppRecurringPricing" || details?.interval);
      return {
        ...subscription,
        cycle: cycleFromInterval(recurring?.interval),
        priceAmount: recurring?.price?.amount ?? null,
        currencyCode: recurring?.price?.currencyCode ?? null,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("billing_fetch_subscriptions_failed", { error_message: message });
    throw error;
  }
}

/**
 * The live paid SourceTrac subscription on Shopify, or null. Source of truth for
 * cancelling. Uses the same test-charge rule as `paidPlanFromSubscriptions`, so
 * the subscription stored or cancelled is the one actually billed.
 */
export function activeSourceTracSubscription(
  subscriptions: ActiveSubscription[],
  { allowTest = process.env.NODE_ENV !== "production" }: { allowTest?: boolean } = {},
): ActiveSubscription | null {
  return (
    subscriptions.find((subscription) => {
      const name = subscription.name.toLowerCase();
      return (
        !(subscription.test && !allowTest) &&
        name.startsWith("sourcetrac") &&
        subscription.status.toUpperCase() === "ACTIVE" &&
        (name.includes("growth") || name.includes("scale"))
      );
    }) ?? null
  );
}

/** Development-store answers, cached per shop: one Admin call per hour at most. */
const devStoreCache = new Map<string, { value: boolean; expiresAt: number }>();

/**
 * Whether test charges count for this shop: always outside production, and on
 * a development store (which can approve nothing else). A failed lookup counts
 * as "not a development store", the stricter choice.
 */
export async function testChargesAllowed(shopDomain: string, accessToken: string): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  const cached = devStoreCache.get(shopDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value = false;
  try {
    value = await fetchIsDevelopmentStore(shopDomain, accessToken);
  } catch (error) {
    logger.warn("billing_dev_store_lookup_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (devStoreCache.size > 10_000) devStoreCache.clear();
  devStoreCache.set(shopDomain, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

/**
 * The paid plan a shop currently holds, or null for free.
 *
 * A test charge never grants a paid plan in production. Test charges cost the
 * merchant nothing, and one can exist on a live store if a development build
 * was ever pointed at it; honouring it would hand out unlimited responses for
 * free and stamp the shop `active` on every Plans page load.
 */
export function paidPlanFromSubscriptions(
  subscriptions: ActiveSubscription[],
  { allowTest = process.env.NODE_ENV !== "production" }: { allowTest?: boolean } = {},
): PlanKey | null {
  for (const subscription of subscriptions) {
    const name = subscription.name.toLowerCase();
    if (subscription.test && !allowTest) continue;
    if (!name.startsWith("sourcetrac")) continue;
    if (subscription.status.toUpperCase() !== "ACTIVE") continue;
    if (name.includes("growth")) return "growth";
    if (name.includes("scale")) return "scale";
  }
  return null;
}

export { isPlanKey };

/** The billing cycle of a subscription; monthly when Shopify did not say. */
export function cycleOf(subscription: Pick<ActiveSubscription, "cycle"> | null | undefined): BillingCycle {
  return subscription?.cycle ?? "monthly";
}

/**
 * Whether the Plans page must rewrite the stored plan to match Shopify.
 *
 * True when the plan differs, and also when Shopify reports the stored paid
 * plan ACTIVE but our status is not `active` (a `frozen` pending charge, or a
 * stale status). Without the second case the page showed the paid plan as
 * current while the survey enforced the Free cap.
 */
export function needsPlanSync(
  stored: { plan: string; planStatus: string },
  live: PlanKey,
): boolean {
  return live !== stored.plan || (live !== "free" && stored.planStatus !== "active");
}
