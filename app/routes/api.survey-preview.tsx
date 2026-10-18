import { data } from "react-router";

import { surveyIdSchema } from "~/lib/settings";
import { toResponse } from "~/lib/http.server";
import { serialiseError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { BUCKETS, consumeToken } from "~/lib/rate-limit.server";
import { findShopByDomain } from "~/lib/shop.server";
import { recordBlockSeen } from "~/lib/block-seen.server";
import { compileSurvey, getCompiledConfig, getSurveyRow } from "~/lib/surveys.server";
import { authenticateCheckout } from "~/lib/checkout-auth.server";
import { hasAudienceRules, PLACEMENTS, type Placement } from "@shared/survey-config";

/**
 * GET /api/survey-preview
 *
 * What a checkout block shows inside Shopify's checkout editor, where there is
 * no real order. The block used to draw a fixed sample question, so a merchant
 * could not see which of their surveys a block would show, or what it said.
 *
 * - With `surveyId` (the block's "Survey ID" setting): that survey, whatever
 *   its status, so a draft can be checked before it goes live. The response
 *   says the status, and the block labels a survey that buyers will not see.
 * - Without it: the live survey with the highest priority on this page. That
 *   is the normal pick before targeting, which needs a real order.
 *
 * Shop identity is the session token's `dest`, never a query field, so a block
 * can only ever preview its own shop's surveys. The only write is the note
 * that a block was seen on this page (`recordBlockSeen`).
 */

export type SurveyPreviewBody = {
  survey: ReturnType<typeof compileSurvey> | null;
  name: string | null;
  status: "draft" | "active" | "paused" | null;
  /** True when the block names a survey; false when it shows the normal pick. */
  pinned: boolean;
  /**
   * False when the named survey is not set to show on this block's page, so
   * buyers would see nothing here even once it is live.
   */
  onThisPage: boolean;
  /** Why there is nothing to show. */
  reason: "not_found" | "none_live" | null;
  /**
   * The survey is live but beyond the plan's number of live surveys, so
   * buyers are not shown it (`getCompiledConfig` serves the plan's share).
   */
  planHidden: boolean;
  /** Rules under "Who sees it" mean some orders will not see it. */
  audienceRules: boolean;
};

export const loader = async ({ request }: { request: Request }) => {
  const requestId = `prv_${Date.now().toString(36)}`;

  const { cors, shopDomain } = await authenticateCheckout(request, "api_survey_preview");

  try {
    const url = new URL(request.url);
    const rawPlacement = url.searchParams.get("placement");
    const placement: Placement = PLACEMENTS.includes(rawPlacement as Placement) ? (rawPlacement as Placement) : "thank_you";
    const surveyId = surveyIdSchema.parse(url.searchParams.get("surveyId") ?? undefined) ?? null;

    consumeToken(`survey-preview:${shopDomain}`, BUCKETS.surveyConfig);

    const empty = (reason: SurveyPreviewBody["reason"], pinned: boolean): SurveyPreviewBody => ({
      survey: null,
      name: null,
      status: null,
      pinned,
      onThisPage: true,
      reason,
      planHidden: false,
      audienceRules: false,
    });

    const shop = await findShopByDomain(shopDomain);
    if (!shop || shop.installState === "uninstalled") {
      return cors(toResponse(data(empty("none_live", Boolean(surveyId)))));
    }
    // The checkout editor only draws a block that has been placed on the page.
    await recordBlockSeen(shop.id, placement);

    let body: SurveyPreviewBody;
    if (surveyId) {
      const [row, config] = await Promise.all([getSurveyRow(shop.id, surveyId), getCompiledConfig(shop.id)]);
      if (row) {
        const survey = compileSurvey(row);
        body = {
          survey,
          name: row.name,
          status: row.status,
          pinned: true,
          onThisPage: survey.placements.includes(placement),
          reason: null,
          planHidden: row.status === "active" && !config.surveys.some((candidate) => candidate.id === row.id),
          audienceRules: hasAudienceRules(survey.targeting, survey.paymentManualOnly),
        };
      } else {
        body = empty("not_found", true);
      }
    } else {
      const config = await getCompiledConfig(shop.id);
      const top = config.surveys.find((candidate) => candidate.placements.includes(placement)) ?? null;
      if (top) {
        const row = await getSurveyRow(shop.id, top.id);
        body = {
          survey: top,
          name: row?.name ?? null,
          status: "active",
          pinned: false,
          onThisPage: true,
          reason: null,
          planHidden: false,
          audienceRules: hasAudienceRules(top.targeting, top.paymentManualOnly),
        };
      } else {
        body = empty("none_live", false);
      }
    }

    logger.info("survey_preview_served", {
      request_id: requestId,
      shop_domain: shopDomain,
      placement,
      pinned: body.pinned,
      found: Boolean(body.survey),
    });
    return cors(toResponse(data(body)));
  } catch (error) {
    const { status, body } = serialiseError(error, {
      request_id: requestId,
      shop_domain: shopDomain,
      route: "api_survey_preview",
    });
    return cors(toResponse(body, { status }));
  }
};

/** Answers the browser's OPTIONS preflight, and any other non-GET probe. */
export const action = async ({ request }: { request: Request }) => {
  const { cors } = await authenticateCheckout(request, "api_survey_preview");
  return cors(toResponse({ error: { code: "method_not_allowed" } }, { status: 405, headers: { Allow: "GET, OPTIONS" } }));
};
