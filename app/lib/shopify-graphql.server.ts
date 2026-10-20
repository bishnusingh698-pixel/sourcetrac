/**
 * Minimal Admin GraphQL client.
 *
 * Deliberately not the full @shopify/shopify-api client: SourceTrac makes two
 * narrow queries (shop plan, app installation status), and pulling in the whole
 * SDK for that would add install weight and a second session-storage path.
 *
 * Every call goes to the Admin GraphQL endpoint (no REST), at the pinned
 * `API_VERSION` (app/lib/env.ts).
 *
 * Docs:
 *   - Throttling: https://shopify.dev/docs/api/usage/limits
 *   - Calculated query cost: https://shopify.dev/docs/api/usage/limits#calculated-query-cost
 */

import { env } from "./env";
import { logger } from "./logger";
import { withRetry } from "./retry.server";

export type GraphQLError = {
  message: string;
  extensions?: { code?: string };
};

export class ShopifyGraphQLError extends Error {
  readonly errors: GraphQLError[];
  readonly userErrors: GraphQLError[];

  constructor(errors: GraphQLError[], userErrors: GraphQLError[] = []) {
    super(errors[0]?.message ?? "Shopify GraphQL request failed");
    this.name = "ShopifyGraphQLError";
    this.errors = errors;
    this.userErrors = userErrors;
  }
}

export class ShopifyThrottledError extends ShopifyGraphQLError {
  constructor(errors: GraphQLError[]) {
    super(errors);
    this.name = "ShopifyThrottledError";
  }
}

/** Throttle codes Shopify returns for rate limiting and token-bucket depletion. */
const THROTTLE_CODES = new Set(["THROTTLED", "INTERNAL_SERVER_ERROR"]);

function isRejectedBeforeRunning(error: unknown): boolean {
  if (error instanceof ShopifyGraphQLError && error.errors.some((e) => e.extensions?.code === "THROTTLED")) return true;
  return error instanceof ShopifyThrottledError && error.message.startsWith("429");
}

/**
 * Whether a failed call may still have run on Shopify's side: a 5xx, a timeout,
 * or a connection that dropped after the request was sent. A 4xx, a throttle, a
 * GraphQL error or userErrors mean Shopify did not do the work.
 */
export function mayHaveRun(error: unknown): boolean {
  if (error instanceof ShopifyThrottledError) return error.message.startsWith("Upstream");
  if (error instanceof ShopifyGraphQLError) return false;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  if (error instanceof TypeError) {
    // fetch failed: only a refused or unresolved connection certainly never sent the request.
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    return !(code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN");
  }
  return false;
}

export function isThrottle(error: unknown): boolean {
  if (error instanceof ShopifyThrottledError) return true;
  return error instanceof ShopifyGraphQLError && error.errors.some((e) => e.extensions?.code && THROTTLE_CODES.has(e.extensions.code));
}

/**
 * Shopify's own words from a 4xx body, so the merchant and the logs see why a
 * call was refused ("Invalid API key or access token") rather than a bare
 * status. The body is `{"errors": "..."}` or `{"errors": [{"message": ...}]}`;
 * anything else (an HTML page) yields nothing.
 */
export function httpErrorDetail(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const errors = (parsed as { errors?: unknown } | null)?.errors;
  const text =
    typeof errors === "string"
      ? errors
      : Array.isArray(errors)
        ? errors
            .map((e) => (typeof e === "string" ? e : (e as { message?: unknown })?.message))
            .filter((m): m is string => typeof m === "string")
            .join("; ")
        : "";
  const trimmed = text.trim().slice(0, 200);
  return trimmed || null;
}

export type GraphQLResponse<T> = { data: T; extensions?: Record<string, unknown> };

/**
 * Execute a query or mutation against the Admin API.
 *
 * `timeoutMs` is generous on purpose: during a Render cold start the first
 * request may also be paying for a Neon wake-up, and we'd rather wait than
 * fail a webhook.
 */
export async function shopifyGraphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  { idempotent = true }: { idempotent?: boolean } = {},
): Promise<GraphQLResponse<T>> {
  const { SHOPIFY_API_VERSION: apiVersion, SHOPIFY_API_KEY: apiKey } = env();
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  return withRetry(
    async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
          // Shopify recommends sending the app key; it improves attribution.
          "X-Shopify-Shop-Api-Key": apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });

      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await new Promise((r) => setTimeout(r, Math.min(retryAfter * 1000, 5000)));
        }
        throw new ShopifyThrottledError([{ message: `429 from Shopify (${response.status})` }]);
      }

      if (response.status >= 500) {
        throw new ShopifyThrottledError([{ message: `Upstream ${response.status} from Shopify` }]);
      }

      if (!response.ok) {
        // 4xx other than 429 will not succeed on retry.
        const body = await response.text().catch(() => "");
        logger.error("shopify_graphql_http_error", {
          shop_domain: shopDomain,
          status: response.status,
          body_preview: body.slice(0, 300),
        });
        const detail = httpErrorDetail(body);
        throw new ShopifyGraphQLError([
          { message: detail ? `Shopify returned ${response.status}: ${detail}` : `Shopify returned ${response.status}` },
        ]);
      }

      const payload = (await response.json()) as GraphQLResponse<T> & { errors?: GraphQLError[] };

      if (payload.errors && payload.errors.length > 0) {
        throw new ShopifyGraphQLError(payload.errors);
      }

      return payload;
    },
    {
      attempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      // A non-idempotent mutation (a Flow trigger, a new subscription) is only
      // retried when Shopify certainly did not run it: a 429 or a THROTTLED
      // error. A 5xx may have landed after the work was done.
      shouldRetry: idempotent ? isThrottle : isRejectedBeforeRunning,
      // A 4xx is permanent; retrying wastes a webhook delivery.
      isAbort: (error) => error instanceof ShopifyGraphQLError && !isThrottle(error),
      onRetry: (error, attempt, delayMs) => {
        logger.warn("shopify_graphql_retry", {
          shop_domain: shopDomain,
          attempt,
          delay_ms: delayMs,
          error_message: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );
}

export const PLANS_QUERY = `#graphql
  query SourceTracPlans {
    appInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                interval
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const SHOP_STATUS_QUERY = `#graphql
  query SourceTracShopStatus {
    shop {
      id
      myshopifyDomain
      currencyCode
    }
  }
`;

export const SHOP_TIMEZONE_QUERY = `#graphql
  query SourceTracShopTimezone {
    shop {
      ianaTimezone
      shopAddress {
        countryCodeV2
      }
    }
  }
`;

export const SHOP_DISPLAY_QUERY = `#graphql
  query SourceTracShopDisplay {
    shop {
      name
      currencyCode
      primaryDomain {
        url
      }
    }
    products(first: 1, query: "status:active") {
      nodes {
        title
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
      }
    }
  }
`;

/**
 * The shop name, presentment currency and one active product, for the Studio's
 * realistic checkout mock (S2). Cached per shop for ten minutes by the caller.
 *
 * Never returns real order or customer data: the mock always uses the fixed
 * sample name "Alex" and order "#1001".
 */
export async function fetchShopDisplay(
  shopDomain: string,
  accessToken: string | null | undefined,
): Promise<{
  name: string | null;
  currencyCode: string | null;
  product: { title: string; imageUrl: string | null } | null;
}> {
  if (!accessToken) return { name: null, currencyCode: null, product: null };
  try {
    const result = await shopifyGraphql<{
      shop: { name: string | null; currencyCode: string | null } | null;
      // `featuredImage` is deprecated; `featuredMedia.preview.image` replaces it.
      products: {
        nodes: Array<{ title: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null }>;
      } | null;
    }>(shopDomain, accessToken, SHOP_DISPLAY_QUERY);
    const node = result.data.products?.nodes?.[0];
    return {
      name: result.data.shop?.name ?? null,
      currencyCode: result.data.shop?.currencyCode ?? null,
      product: node ? { title: node.title, imageUrl: node.featuredMedia?.preview?.image?.url ?? null } : null,
    };
  } catch (error) {
    logger.warn("shop_display_lookup_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return { name: null, currencyCode: null, product: null };
  }
}

/**
 * Product titles for a set of numeric product ids (T8).
 *
 * One batched `nodes` query, so the Results tab never issues a request per
 * product. Ids that no longer resolve are simply absent from the map; the caller
 * falls back to the raw id. Never throws — a failed lookup degrades the labels,
 * not the table.
 */
export async function fetchProductTitles(
  shopDomain: string,
  accessToken: string | null | undefined,
  productIds: ReadonlyArray<string>,
): Promise<Record<string, string>> {
  const ids = [...new Set(productIds.filter((id) => /^\d+$/.test(id)))].slice(0, 100);
  if (!accessToken || ids.length === 0) return {};
  try {
    const result = await shopifyGraphql<{
      nodes: Array<{ id?: string; title?: string } | null>;
    }>(
      shopDomain,
      accessToken,
      `#graphql
        query SourceTracProductTitles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product { id title }
          }
        }
      `,
      { ids: ids.map((id) => `gid://shopify/Product/${id}`) },
    );
    const titles: Record<string, string> = {};
    for (const node of result.data.nodes ?? []) {
      if (!node?.id || !node.title) continue;
      const numeric = node.id.split("/").pop();
      if (numeric) titles[numeric] = node.title;
    }
    return titles;
  } catch (error) {
    logger.warn("product_titles_lookup_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * The shop's IANA time zone (e.g. "Asia/Kolkata") and store country (ISO-3166
 * alpha-2, e.g. "US"), or null when Shopify could not be asked.
 *
 * The country picks the answer-pack region for the template library; a failed
 * lookup degrades to the US/default region rather than hiding the library. Both
 * fields arrive from the same cheap query, so neither costs an extra round trip.
 * `shopAddress.countryCodeV2` is verified against the Admin GraphQL schema
 * (`billingAddress` on Shop is the deprecated spelling of the same thing).
 */
export async function fetchShopLocaleInfo(
  shopDomain: string,
  accessToken: string | null | undefined,
): Promise<{ timeZone: string | null; countryCode: string | null }> {
  if (!accessToken) return { timeZone: null, countryCode: null };
  try {
    const result = await shopifyGraphql<{
      shop: { ianaTimezone: string | null; shopAddress: { countryCodeV2: string | null } | null } | null;
    }>(shopDomain, accessToken, SHOP_TIMEZONE_QUERY);
    return {
      timeZone: result.data.shop?.ianaTimezone ?? null,
      countryCode: result.data.shop?.shopAddress?.countryCodeV2 ?? null,
    };
  } catch (error) {
    logger.warn("shop_locale_info_lookup_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return { timeZone: null, countryCode: null };
  }
}

/**
 * The shop's IANA time zone, or null when Shopify could not be asked. The export
 * then falls back to UTC and says so in its `timezone` column, so a failed lookup
 * degrades the file rather than failing the download.
 */
export async function fetchShopTimeZone(shopDomain: string, accessToken: string | null | undefined): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const result = await shopifyGraphql<{ shop: { ianaTimezone: string | null } | null }>(
      shopDomain,
      accessToken,
      `#graphql
        query SourceTracShopTimezoneOnly { shop { ianaTimezone } }
      `,
    );
    return result.data.shop?.ianaTimezone ?? null;
  } catch (error) {
    logger.warn("shop_timezone_lookup_failed", {
      shop_domain: shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
