import { data } from "react-router";
import { z } from "zod";

import { orderIdSchema, surveyIdSchema } from "~/lib/settings";
import { toResponse } from "~/lib/http.server";
import { serialiseError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { minorUnitDigits, parseMoneyToMinor } from "~/lib/money";
import { BUCKETS, consumeShopBackstop, consumeToken } from "~/lib/rate-limit.server";
import { hasAnyAnswerForOrder } from "~/lib/answers.server";
import { findShopByDomain, isKnownOrder } from "~/lib/shop.server";
import { recordBlockSeen } from "~/lib/block-seen.server";
import { getCompiledConfig } from "~/lib/surveys.server";
import { authenticate } from "~/shopify.server";
import { matchesTargeting, matchesPaymentRule, pickFromRotation, rotationGroup, PLACEMENTS, type Placement } from "@shared/survey-config";
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
  /** Comma-separated payment option types, e.g. "manualPayment". */
  paymentTypes: z.string().max(200).optional(),
  /** "1"/"0" — the buyer's first completed order with this shop. */
  isFirstOrder: z.enum(["0", "1"]).optional(),
  /** ISO 3166-1 alpha-2, from the checkout/customer-account localization API. */
  country: z.string().length(2).optional(),
  /** The survey this block is pinned to, from the block's "Survey ID" setting. */
  surveyId: surveyIdSchema,
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
      paymentTypes: url.searchParams.get("paymentTypes") ?? undefined,
      isFirstOrder: url.searchParams.get("isFirstOrder") ?? undefined,
      country: url.searchParams.get("country") ?? undefined,
      surveyId: url.searchParams.get("surveyId") || undefined,
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
    await recordBlockSeen(shop.id, placement);

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

    // `maxResponses` must read the live count: the compiled config is cached
    // for up to a minute, so a busy survey kept collecting past its limit.
    const capped = config.surveys.filter((candidate) => candidate.targeting?.maxResponses != null);
    const liveCounts = new Map<string, number>();
    if (capped.length > 0) {
      const rows = await db.survey.findMany({
        where: { shopId: shop.id, id: { in: capped.map((candidate) => candidate.id) } },
        select: { id: true, responseCount: true },
      });
      for (const row of rows) liveCounts.set(row.id, row.responseCount);
    }

    const paymentTypes = parsed.data.paymentTypes
      ? parsed.data.paymentTypes.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const matches = (candidate: (typeof config.surveys)[number]) =>
      candidate.placements.includes(placement) &&
      matchesPaymentRule(candidate, paymentTypes, placement) &&
      matchesTargeting(candidate.targeting, {
        orderId,
        orderTotalMinor,
        currency: order?.currency ?? null,
        currencyDigits: order ? minorUnitDigits(order.currency) : 2,
        // Both come from the extension's host API. Absent (the Order-status
        // page has no first-order signal) fails a first/returning or country
        // rule: the merchant asked for that audience only, so an unknown buyer
        // is not shown the survey. See DECISIONS.md (L17).
        isFirstOrder: parsed.data.isFirstOrder === undefined ? null : parsed.data.isFirstOrder === "1",
        country: parsed.data.country?.toUpperCase() ?? null,
        language: parsed.data.locale ?? null,
        now,
        // The survey's own collected count, so `maxResponses` can fire. It was
        // hardcoded to 0, so "pause after N responses" never triggered.
        responseCount: liveCounts.get(candidate.id) ?? candidate.responseCount,
      });

    // A block pinned to one survey shows that survey or nothing: a merchant who
    // paused it does not want another survey appearing in its place. An id that
    // names no survey at all (deleted, or mistyped) falls back to the normal
    // pick, so a stale setting never leaves the page without a survey.
    const pinnedId = parsed.data.surveyId ?? null;
    const pinned = pinnedId ? (config.surveys.find((candidate) => candidate.id === pinnedId) ?? null) : null;
    const pinnedExists = pinnedId
      ? pinned !== null || (await db.survey.count({ where: { id: pinnedId, shopId: shop.id } })) > 0
      : false;

    let survey: (typeof config.surveys)[number] | null;
    if (pinnedExists) {
      survey = pinned && matches(pinned) ? pinned : null;
    } else {
      // T11: the highest-priority match wins, unless it is in the rotation
      // group, in which case one member is chosen by a deterministic, weighted
      // pick so the same order sees the same survey on both surfaces.
      const ranked = config.surveys.filter(matches);
      const top = ranked[0] ?? null;
      survey = top;
      if (top && top.rotation) {
        const group = rotationGroup(config.surveys, placement, matches).sort((a, b) => b.priority - a.priority);
        survey = pickFromRotation(group, orderId) ?? top;
      }
    }

    logger.info("survey_config_served_v2", {
      request_id: requestId,
      shop_domain: shopDomain,
      order_id: orderId,
      placement,
      matched: Boolean(survey),
      pinned: pinnedExists,
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
