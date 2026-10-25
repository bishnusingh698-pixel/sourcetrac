/**
 * REST calls to the Admin API.
 *
 * Used for the one thing GraphQL does not give us: whether the store's plan
 * supports checkout UI extensions, which surfaces only on the REST shop
 * resource (`plan.display_name`).
 *
 * Docs: https://shopify.dev/docs/api/admin-rest/2026-07/resources/shop
 */

import { logger } from "./logger";
import { shopifyGraphql, SHOP_STATUS_QUERY } from "./shopify-graphql.server";

export type ShopPlan = {
  displayName: string;
  /** True only when the plan name matches Starter. Compared case-insensitively. */
  isStarter: boolean;
};

export type ShopInfo = {
  id: string;
  myshopifyDomain: string;
  currencyCode: string;
};

/**
 * Shopify documents `ShopPlan.publicDisplayName` as one of a closed set of
 * values: Advanced, Agentic, Agentic Enterprise, Basic, Development, Grow,
 * Inactive, Lite, Other, Paused, Plus, Plus Trial, Retail, Shop Component,
 * Staff Business, Starter, Trial.
 *
 * Checkout UI extensions for the information/shipping/payment steps require
 * Shopify Plus, but the Thank-you and Order-status targets are available on all
 * plans except Starter. Starter is therefore the plan that blocks the survey.
 *
 * Source: https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopPlan
 *         https://shopify.dev/docs/api/checkout-ui-extensions/latest
 */
export const PLAN_DISPLAY_NAMES = [
  "Advanced",
  "Agentic",
  "Agentic Enterprise",
  "Basic",
  "Development",
  "Grow",
  "Inactive",
  "Lite",
  "Other",
  "Paused",
  "Plus",
  "Plus Trial",
  "Retail",
  "Shop Component",
  "Staff Business",
  "Starter",
  "Trial",
] as const;

/**
 * Plans that cannot host the Thank-you / Order-status surfaces. Only drives the
 * admin warning banner; the extension routes do not gate on it.
 *
 * Trial and Plus Trial are not here: Shopify excludes only Starter, and a store
 * on its trial is exactly where a new merchant tests the survey. Listing them
 * told those merchants the survey could not appear.
 */
export const UNSUPPORTED_PLANS = new Set(["Starter", "Inactive", "Paused", "Shop Component"]);

/**
 * Whether the Thank-you / Order-status surfaces can host the survey.
 *
 * Returns null when the plan is unrecognised, so the UI can say "we could not
 * confirm" rather than a wrong yes/no.
 */
export function checkoutSurfacesSupported(publicDisplayName: string | null | undefined): boolean | null {
  const raw = (publicDisplayName ?? "").trim();
  if (raw.length === 0) return null;

  const match = PLAN_DISPLAY_NAMES.find((p) => p.toLowerCase() === raw.toLowerCase());
  if (!match) return null;

  return !UNSUPPORTED_PLANS.has(match);
}

/**
 * Read the store's plan via GraphQL `shop.plan.publicDisplayName`.
 * `displayName` is deprecated in favour of `publicDisplayName`.
 *
 * Returns null when Shopify gives us nothing usable, so the caller can show
 * "we could not confirm" instead of guessing.
 */
export async function fetchShopPlanName(shopDomain: string, accessToken: string): Promise<string | null> {
  try {
    const response = await shopifyGraphql<{ shop?: { plan?: { publicDisplayName?: string } } }>(
      shopDomain,
      accessToken,
      `#graphql
        query SourceTracPlan {
          shop {
            plan {
              publicDisplayName
              partnerDevelopment
            }
          }
        }
      `,
    );
    const name = response.data?.shop?.plan?.publicDisplayName;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch (error) {
    // Non-fatal: onboarding falls back to "could not confirm".
    logger.warn("shop_plan_lookup_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Whether the store is a development store (Partner or dev-preview). Such a
 * store can only approve TEST charges, which is how App Store review installs
 * the app, so billing must create and honour test charges there. Throws when
 * Shopify cannot be asked; callers decide the fallback.
 */
export async function fetchIsDevelopmentStore(shopDomain: string, accessToken: string): Promise<boolean> {
  const response = await shopifyGraphql<{ shop?: { plan?: { partnerDevelopment?: boolean } } }>(
    shopDomain,
    accessToken,
    `#graphql
      query SourceTracPlan {
        shop {
          plan {
            publicDisplayName
            partnerDevelopment
          }
        }
      }
    `,
  );
  return response.data?.shop?.plan?.partnerDevelopment === true;
}

export async function fetchShopIdentity(shopDomain: string, accessToken: string): Promise<ShopInfo> {
  const response = await shopifyGraphql<{ shop: { id: string; myshopifyDomain: string; currencyCode: string } }>(
    shopDomain,
    accessToken,
    SHOP_STATUS_QUERY,
  );
  return response.data.shop;
}
