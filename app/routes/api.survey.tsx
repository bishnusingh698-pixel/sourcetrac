import { data } from "react-router";
import { z } from "zod";

import { orderIdSchema, surveyIdSchema } from "~/lib/settings";
import { toResponse } from "~/lib/http.server";
import { serialiseError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { minorUnitDigits, parseMoneyToMinor } from "~/lib/money";
import { BUCKETS, consumeShopBackstop, consumeToken } from "~/lib/rate-limit.server";
import { hasAnyAnswerForOrder } from "~/lib/answers.server";
import { findShopByDomain } from "~/lib/shop.server";
import { isRealOrder } from "~/lib/order-verify.server";
import { recordBlockSeen } from "~/lib/block-seen.server";
import { readOrderFact, recordOrderFact } from "~/lib/order-facts.server";
import { recordServe, type ServeReason } from "~/lib/serve-log.server";
import { getCompiledConfig } from "~/lib/surveys.server";
import { authenticateCheckout } from "~/lib/checkout-auth.server";
import {
  explainTargeting,
  matchesPaymentRule,
  pickFromRotation,
  rotationGroup,
  PLACEMENTS,
  type CompiledConfig,
  type Placement,
} from "@shared/survey-config";
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
  /**
   * The order total as the checkout shows it (`cost.totalAmount`), for the
   * order-value rule before the order webhook has landed. Targeting only:
   * revenue always comes from the webhook.
   */
  total: z.string().max(24).optional(),
  totalCurrency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  /** The survey this block is pinned to, from the block's "Survey ID" setting. */
  surveyId: surveyIdSchema,
});

type Candidate = CompiledConfig["surveys"][number];


export const loader = async ({ request }: { request: Request }) => {
  const requestId = `srv_${Date.now().toString(36)}`;

  const { cors, shopDomain } = await authenticateCheckout(request, "api_survey");

  try {
    const url = new URL(request.url);
    const read = (key: string) => url.searchParams.get(key) || undefined;
    const parsed = querySchema.safeParse({
      orderId: read("orderId"),
      placement: read("placement"),
      locale: read("locale"),
      paymentTypes: read("paymentTypes"),
      isFirstOrder: read("isFirstOrder"),
      country: read("country"),
      total: read("total"),
      totalCurrency: read("totalCurrency"),
      surveyId: read("surveyId"),
    });

    if (!parsed.success) {
      throw new ValidationError("A valid orderId and placement are required.", "Reload the checkout page and try again.", {
        field: "orderId",
      });
    }

    // From the validated value: an empty `placement=` used to pass the schema
    // (read as absent) and then be used raw, as no page at all.
    const placement: Placement = parsed.data.placement ?? "thank_you";
    const orderId = parsed.data.orderId ?? null;
    consumeToken(`survey:${shopDomain}:${orderId ?? "none"}:${placement}`, BUCKETS.surveyConfig);
    if (orderId) {
      await consumeShopBackstop(`survey-shop:${shopDomain}`, BUCKETS.surveyConfigShop, () =>
        isRealOrder(shopDomain, orderId),
      );
    }

    const shop = await findShopByDomain(shopDomain);
    if (!shop || shop.installState === "uninstalled") {
      logger.warn("survey_no_shop", { request_id: requestId, shop_domain: shopDomain });
      return cors(toResponse(data({ enabled: false, reason: "not_installed" })));
    }

    const reportedFirstOrder = parsed.data.isFirstOrder === undefined ? null : parsed.data.isFirstOrder === "1";

    // Independent queries, run together. On a database that has just woken
    // each round trip is slow, and the buyer is watching the page meanwhile.
    // `recordBlockSeen`, `recordOrderFact` and `readOrderFact` never throw.
    const pinnedId = parsed.data.surveyId ?? null;
    const [, alreadyAnswered, config, order, pinnedRows, rememberedFirstOrder] = await Promise.all([
      recordBlockSeen(shop.id, placement),
      orderId ? hasAnyAnswerForOrder(shop.id, orderId) : Promise.resolve(false),
      getCompiledConfig(shop.id),
      // Order facts for targeting. Nothing identifying is read.
      orderId
        ? db.orderCache.findUnique({
            where: { shopId_orderId: { shopId: shop.id, orderId } },
            select: { totalPrice: true, currency: true },
          })
        : Promise.resolve(null),
      pinnedId ? db.survey.count({ where: { id: pinnedId, shopId: shop.id } }) : Promise.resolve(0),
      // The Thank-you page reports whether this is the buyer's first order;
      // the Order status page cannot, so it reads what Thank-you reported.
      orderId && reportedFirstOrder === null
        ? readOrderFact(shop.id, orderId)
        : orderId && reportedFirstOrder !== null && placement === "thank_you"
          ? recordOrderFact(shop.id, orderId, reportedFirstOrder).then(() => null)
          : Promise.resolve(null),
    ]);
    const isFirstOrder = reportedFirstOrder ?? rememberedFirstOrder;
    const now = new Date();

    // The order's total for the order-value rule: the webhook's when it has
    // landed (shop currency, the currency the merchant set the rule in),
    // otherwise what the checkout shows. On the Thank-you page the webhook
    // has usually not arrived yet, so without the checkout's figure the rule
    // never applied there and the survey showed on every order.
    const cached = order?.totalPrice ? parseMoneyToMinor(order.totalPrice.toString(), order.currency) : null;
    const reportedCurrency = parsed.data.totalCurrency?.toUpperCase() ?? null;
    const reported =
      !cached?.ok && parsed.data.total && reportedCurrency ? parseMoneyToMinor(parsed.data.total, reportedCurrency) : null;
    const totalCurrency = cached?.ok ? order!.currency : reported?.ok ? reportedCurrency : null;
    const orderTotalMinor = cached?.ok ? cached.minor : reported?.ok ? reported.minor : null;

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
    const country = parsed.data.country?.toUpperCase() ?? null;

    /** Why this survey cannot be shown on this order, or null when it can. */
    const miss = (candidate: Candidate): ServeReason | null => {
      if (!candidate.placements.includes(placement)) return "not_on_page";
      if (!matchesPaymentRule(candidate, paymentTypes, placement)) return "payment_rule";
      return explainTargeting(candidate.targeting, {
        orderId,
        orderTotalMinor,
        currency: totalCurrency,
        currencyDigits: totalCurrency ? minorUnitDigits(totalCurrency) : 2,
        // Unknown (no Thank-you report for this order) fails a first/returning
        // rule: the merchant asked for that audience only, so an unknown buyer
        // is not shown the survey.
        isFirstOrder,
        country,
        language: parsed.data.locale ?? null,
        now,
        // The survey's own collected count, so `maxResponses` can fire.
        responseCount: liveCounts.get(candidate.id) ?? candidate.responseCount,
      });
    };
    const matches = (candidate: Candidate) => miss(candidate) === null;

    // A block pinned to one survey shows that survey or nothing: a merchant who
    // paused it does not want another survey appearing in its place. An id that
    // names no survey at all (deleted, or mistyped) falls back to the normal
    // pick, so a stale setting never leaves the page without a survey.
    const pinned = pinnedId ? (config.surveys.find((candidate) => candidate.id === pinnedId) ?? null) : null;
    const pinnedExists = pinnedId ? pinned !== null || pinnedRows > 0 : false;

    let survey: Candidate | null;
    let reason: ServeReason;
    let reasonSurveyId: string | null = null;
    if (pinnedExists) {
      const why = pinned ? miss(pinned) : "pinned_not_live";
      survey = why === null ? pinned : null;
      reason = why === null ? "shown" : why === "not_on_page" ? "pinned_other_page" : why;
      reasonSurveyId = pinnedId;
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
      if (survey) {
        reason = "shown";
        reasonSurveyId = survey.id;
      } else {
        // Report the rule that hid the survey the merchant most expects here:
        // the highest-priority one set to show on this page.
        const onPage = config.surveys.find((candidate) => candidate.placements.includes(placement)) ?? null;
        reason = config.surveys.length === 0 ? "none_live" : onPage ? (miss(onPage) ?? "shown") : "not_on_page";
        reasonSurveyId = onPage?.id ?? null;
      }
    }
    if (survey && alreadyAnswered) reason = "already_answered";

    // For "Recent checkouts" on the Surveys page. Not awaited, never throws.
    void recordServe(shop.id, { placement, orderId, surveyId: reasonSurveyId, reason, pinned: pinnedExists, country, isFirstOrder });

    logger.info("survey_config_served_v2", {
      request_id: requestId,
      shop_domain: shopDomain,
      order_id: orderId,
      placement,
      matched: Boolean(survey),
      reason,
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
          survey: survey ? buyerView(survey) : null,
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

/**
 * The survey as a buyer may see it. Targeting (countries, sample rate, value
 * bounds, answer cap), the answer count, rotation weights and the channel
 * question are the merchant's settings, decided here on the server; the block
 * never reads them.
 */
function buyerView(survey: Candidate) {
  const {
    targeting: _targeting,
    responseCount: _responseCount,
    rotation: _rotation,
    rotationWeight: _rotationWeight,
    priority: _priority,
    channelReportQuestionId: _channelReportQuestionId,
    paymentManualOnly: _paymentManualOnly,
    ...shown
  } = survey;
  return shown;
}

/** Answers the browser's OPTIONS preflight, and any other non-GET probe. */
export const action = async ({ request }: { request: Request }) => {
  const { cors } = await authenticateCheckout(request, "api_survey");
  // Not a real submission endpoint; the loader is the only handler.
  return cors(toResponse({ error: { code: "method_not_allowed" } }, { status: 405, headers: { Allow: "GET, OPTIONS" } }));
};
