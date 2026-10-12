import { data } from "react-router";
import { z } from "zod";

import { orderIdSchema } from "~/lib/settings";
import { toResponse } from "~/lib/http.server";
import { serialiseError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { minorUnitDigits, parseMoneyToMinor } from "~/lib/money";
import { BUCKETS, consumeShopBackstop, consumeToken } from "~/lib/rate-limit.server";
import { hasAnyAnswerForOrder } from "~/lib/answers.server";
import { findShopByDomain, isKnownOrder } from "~/lib/shop.server";
import { getCompiledConfig } from "~/lib/surveys.server";
import { authenticate } from "~/shopify.server";
import { matchesTargeting, PLACEMENTS, type Placement } from "@shared/survey-config";
import { db } from "~/db.server";

/**
 * GET /api/survey
 *
 * The multi-question checkout extension calls this once per Thank-you /
 * Order-status render. It returns the single active survey that targets this
 * order on the requested placement, already compiled, so the extension makes
 * every show/hide decision client-side and a page view costs zero queries beyond
 * this one.
 *
 * Authentication, session-token verification and CORS come from
 * `authenticate.public.checkout` — shop identity is the token's `dest` claim,
 * never anything in the query string.
 *
 * This is the v2 config route. The old `/api/survey-config` stays untouched for
 * the already-deployed single-question extension until it is retired.
 */

const querySchema = z.object({
  orderId: orderIdSchema.optional(),
  placement: z.enum(PLACEMENTS).optional(),
  locale: z.string().max(32).optional(),
});

export const loader = async ({ request }: { request: Request }) => {
  const requestId = `srv_${Date.now().toString(36)}`;

  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shopDomain = sessionToken.dest.toLowerCase();

  try {
    const url = new URL(request.url);
    const placement: Placement = (url.searchParams.get("placement") as Placement | null) ?? "thank_you";
    const parsed = querySchema.safeParse({
      orderId: url.searchParams.get("orderId") ?? undefined,
      placement: url.searchParams.get("placement") ?? undefined,
      locale: url.searchParams.get("locale") ?? undefined,
    });

    if (!parsed.success) {
      throw new ValidationError("A valid orderId and placement are required.", "Reload the checkout page and try again.", {
        field: "orderId",
      });
    }

    const orderId = parsed.data.orderId ?? null;
    consumeToken(`survey:${shopDomain}:${orderId ?? "none"}:${placement}`, BUCKETS.surveyConfig);
    if (orderId) {
      await consumeShopBackstop(`survey-shop:${shopDomain}`, BUCKETS.surveyConfigShop, () =>
        isKnownOrder(shopDomain, orderId),
      );
    }

    const shop = await findShopByDomain(shopDomain);
    if (!shop || shop.installState === "uninstalled") {
      logger.info("survey_no_shop", { request_id: requestId, shop_domain: shopDomain });
      return cors(toResponse(data({ enabled: false, reason: "not_installed" })));
    }

    const alreadyAnswered = orderId ? await hasAnyAnswerForOrder(shop.id, orderId) : false;

    const config = await getCompiledConfig(shop.id);
    const now = new Date();

    // Order facts for targeting. Nothing identifying is read.
    const order = orderId
      ? await db.orderCache.findUnique({
          where: { shopId_orderId: { shopId: shop.id, orderId } },
          select: { totalPrice: true, currency: true },
        })
      : null;
    const parsedTotal = order?.totalPrice ? parseMoneyToMinor(order.totalPrice.toString(), order.currency) : null;
    const orderTotalMinor = parsedTotal?.ok ? parsedTotal.minor : null;

    const survey = config.surveys.find(
      (candidate) =>
        candidate.placements.includes(placement) &&
        matchesTargeting(candidate.targeting, {
          orderId,
          orderTotalMinor,
          currency: order?.currency ?? null,
          currencyDigits: order ? minorUnitDigits(order.currency) : 2,
          isFirstOrder: null,
          country: null,
          language: parsed.data.locale ?? null,
          now,
          responseCount: 0,
        }),
    );

    logger.info("survey_config_served_v2", {
      request_id: requestId,
      shop_domain: shopDomain,
      order_id: orderId,
      placement,
      matched: Boolean(survey),
      already_answered: alreadyAnswered,
    });

    return cors(
      toResponse(
        data({
          enabled: Boolean(survey),
          orderId,
          placement,
          alreadyAnswered,
          survey: survey ?? null,
        }),
      ),
    );
  } catch (error) {
    const { status, body } = serialiseError(error, {
      request_id: requestId,
      shop_domain: shopDomain,
      route: "api_survey",
    });
    return cors(toResponse(body, { status }));
  }
};

/** Answers the browser's OPTIONS preflight, and any other non-GET probe. */
export const action = async ({ request }: { request: Request }) => {
  const { cors } = await authenticate.public.checkout(request);
  // Not a real submission endpoint; the loader is the only handler.
  return cors(toResponse({ error: { code: "method_not_allowed" } }, { status: 405, headers: { Allow: "GET, OPTIONS" } }));
};
