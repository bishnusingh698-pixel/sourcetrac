import { env } from "./env";
import { logger } from "./logger";
import { BILLING_INTERVAL, PLANS, isPlanKey, type PlanKey } from "./plans";
import { PLANS_QUERY, shopifyGraphql } from "./shopify-graphql.server";

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

function mapUserErrors(errors: BillingError[]): string {
  return errors.map((e) => e.message).join("; ") || "Unknown billing error";
}

export type SubscriptionResult =
  | { ok: true; subscriptionGid: string; confirmationUrl: string | null; test: boolean }
  | { ok: false; error: string; userErrors: BillingError[] };

/**
 * Create a recurring charge. In development this is a test charge so the
 * merchant can approve and cancel repeatedly without being billed.
 */
export async function createSubscription(params: {
  shopDomain: string;
  accessToken: string;
  plan: PlanKey;
}): Promise<SubscriptionResult> {
  const definition = PLANS[params.plan];
  const returnUrl = `${env().APP_URL}/app/plans?billing=return`;

  try {
    const response = await shopifyGraphql<{
      appSubscriptionCreate: {
        appSubscription: { id: string; status: string; name: string; test: boolean } | null;
        confirmationUrl: string | null;
        userErrors: BillingError[];
      };
    }>(params.shopDomain, params.accessToken, CREATE_MUTATION, {
      name: definition.displayName,
      returnUrl,
      test: env().NODE_ENV !== "production",
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: definition.priceMinor, currencyCode: definition.currencyCode },
              interval: BILLING_INTERVAL,
            },
          },
        },
      ],
    });

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
        }>;
      } | null;
    }>(params.shopDomain, params.accessToken, PLANS_QUERY);

    return response.data.appInstallation?.activeSubscriptions ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("billing_fetch_subscriptions_failed", { error_message: message });
    throw error;
  }
}

/** The paid plan a shop currently holds, or null for free. */
export function paidPlanFromSubscriptions(subscriptions: ActiveSubscription[]): PlanKey | null {
  for (const subscription of subscriptions) {
    const name = subscription.name.toLowerCase();
    if (!name.startsWith("sourcetrac")) continue;
    if (subscription.status.toUpperCase() !== "ACTIVE") continue;
    if (name.includes("growth")) return "growth";
    if (name.includes("scale")) return "scale";
  }
  return null;
}

export { isPlanKey };
