import { data } from "react-router";
import { z } from "zod";

import { toResponse } from "~/lib/http.server";
import { ValidationError } from "~/lib/errors";
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

const querySchema = z.object({
  orderId: z
    .string()
    .min(1)
    .max(64)
    // Shopify order IDs are numeric. Rejecting anything else keeps arbitrary
    // strings out of the database before they reach a query.
    .regex(/^\d+$/, "orderId must be numeric"),
});

export const loader = async ({ request }: { request: Request }) => {
  const requestId = `cfg_${Date.now().toString(36)}`;

  // Throws a 401 Response when the token is missing, invalid or expired.
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shopDomain = sessionToken.dest.toLowerCase();

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ orderId: url.searchParams.get("orderId") });

  if (!parsed.success) {
    throw new ValidationError("A valid orderId is required.", "Reload the checkout page and try again.", {
      field: "orderId",
    });
  }

  consumeToken(`config:${shopDomain}`, BUCKETS.surveyConfig);

  const shop = await findShopByDomain(shopDomain);

  // An unknown or uninstalled store is not an error the buyer should see.
  // Returning `enabled: false` lets the extension hide itself cleanly.
  if (!shop || shop.installState === "uninstalled") {
    logger.info("survey_config_no_shop", { request_id: requestId, shop_domain: shopDomain });
    return cors(toResponse(data({ enabled: false, reason: "not_installed" })));
  }

  // Unsupported plan: hide the survey rather than render a block that cannot work.
  if (shop.checkoutSupported === false) {
    logger.info("survey_config_plan_unsupported", { request_id: requestId, shop_domain: shopDomain });
    return cors(toResponse(data({ enabled: false, reason: "plan_unsupported" })));
  }

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
};