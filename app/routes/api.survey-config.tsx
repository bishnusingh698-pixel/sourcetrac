import { data } from "react-router";
import { z } from "zod";

import { orderIdSchema } from "~/lib/settings";

import { toResponse } from "~/lib/http.server";
import { serialiseError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { BUCKETS, consumeToken } from "~/lib/rate-limit.server";
import { DEFAULT_OPTIONS, parseSurveySettings } from "~/lib/settings";
import { findShopByDomain, hasResponseFor } from "~/lib/shop.server";
import { maybeMarkUnreconcilable } from "~/lib/responses.server";
import { authenticate } from "~/shopify.server";

/**
 * GET /api/survey-config
 *
 * The checkout extension calls this once per Thank-you / Order-status render to
 * learn the question, the options, and whether this order already answered.
 *
 * Authentication, session-token verification and CORS all come from
 * `authenticate.public.checkout` — the shop identity is the token's `dest`
 * claim, never anything in the query string or body.
 */

const querySchema = z.object({ orderId: orderIdSchema });

export const loader = async ({ request }: { request: Request }) => {
  const requestId = `cfg_${Date.now().toString(36)}`;

  // Throws a 401 Response when the token is missing, invalid or expired. That
  // must keep propagating: the library adds its own CORS headers for it.
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shopDomain = sessionToken.dest.toLowerCase();

  // As in /api/responses, every exit from here is CORS-wrapped. A thrown error
  // would be serialised by React Router without an Access-Control-Allow-Origin
  // header, so the extension would retry a permanent 400 as a network failure.
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ orderId: url.searchParams.get("orderId") });

    if (!parsed.success) {
      throw new ValidationError("A valid orderId is required.", "Reload the checkout page and try again.", {
        field: "orderId",
      });
    }

    // Keyed per order, with a much larger shop-wide ceiling behind it. A single
    // per-shop bucket let one client hammering with a valid token exhaust it and
    // hide the survey from every other buyer of that store.
    consumeToken(`config-shop:${shopDomain}`, BUCKETS.surveyConfigShop);
    consumeToken(`config:${shopDomain}:${parsed.data.orderId}`, BUCKETS.surveyConfig);

    const shop = await findShopByDomain(shopDomain);

    // An unknown or uninstalled store is not an error the buyer should see.
    // Returning `enabled: false` lets the extension hide itself cleanly.
    if (!shop || shop.installState === "uninstalled") {
      logger.info("survey_config_no_shop", { request_id: requestId, shop_domain: shopDomain });
      return cors(toResponse(data({ enabled: false, reason: "not_installed" })));
    }

    // No plan gate here. On a plan that cannot host the block, Shopify never
    // runs the extension, so this request never arrives. Gating on our own
    // stored plan reading only ever hid the survey where Shopify did render it
    // (trial stores were classified as unsupported).

    const settings = parseSurveySettings(shop.optionsJson, {
      questionText: shop.questionText,
      options: DEFAULT_OPTIONS,
      allowOther: shop.allowOther,
    });

    const alreadyAnswered = await hasResponseFor(shop.id, parsed.data.orderId);

    // Fire-and-forget: this is the request path that runs most often, and the
    // sweep rate-limits itself. Kept off the critical path so housekeeping can
    // never delay the buyer seeing the survey.
    void maybeMarkUnreconcilable();

    logger.info("survey_config_served", {
      request_id: requestId,
      shop_domain: shopDomain,
      order_id: parsed.data.orderId,
      already_answered: alreadyAnswered,
    });

    return cors(
      toResponse(data({
        enabled: true,
        questionText: settings.questionText,
        options: settings.options.map(({ value, label, emoji }) => ({ value, label, emoji })),
        allowOther: settings.allowOther,
        orderId: parsed.data.orderId,
        alreadyAnswered,
      })),
    );
  } catch (error) {
    const { status, body } = serialiseError(error, {
      request_id: requestId,
      shop_domain: shopDomain,
      route: "api_survey_config",
    });
    return cors(toResponse(body, { status }));
  }
};
