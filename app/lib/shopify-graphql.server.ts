/**
 * Minimal Admin GraphQL client.
 *
 * Deliberately not the full @shopify/shopify-api client: SourceTrac makes two
 * narrow queries (shop plan, app installation status), and pulling in the whole
 * SDK for that would add install weight and a second session-storage path.
 *
 * Uses the Admin REST API for the shop endpoint, because shop.plan is only
 * readable there — see docs/01-verification-report.md §A9 for why the GraphQL
 * Shop.plan field is not used.
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

function isThrottle(error: unknown): boolean {
  if (error instanceof ShopifyThrottledError) return true;
  return error instanceof ShopifyGraphQLError && error.errors.some((e) => e.extensions?.code && THROTTLE_CODES.has(e.extensions.code));
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
        throw new ShopifyGraphQLError([{ message: `Shopify returned ${response.status}` }]);
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
      shouldRetry: isThrottle,
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
