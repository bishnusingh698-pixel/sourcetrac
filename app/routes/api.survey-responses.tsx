import { data } from "react-router";
import { z } from "zod";

import { orderIdSchema } from "~/lib/settings";
import { readBodyText, toResponse } from "~/lib/http.server";
import { serialiseError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { effectivePlan } from "~/lib/plans";
import {
  BUCKETS,
  checkTokenSubmission,
  consumeShopBackstop,
  consumeToken,
  recordTokenSubmission,
} from "~/lib/rate-limit.server";
import { submitAnswers } from "~/lib/answers.server";
import { findShopByDomain, isKnownOrder } from "~/lib/shop.server";
import { getSurveyRow, rowToEditor } from "~/lib/surveys.server";
import { authenticate } from "~/shopify.server";
import { PLACEMENTS, type Placement } from "@shared/survey-config";
import type { AnswerInput, SurveyDefinition } from "@shared/survey-rules";

/**
 * The survey's main question for the confidence meter: the first question whose
 * answer forms a distribution (a choice, rating or score question). Neutral
 * questions like free text have nothing to measure.
 */
function mainQuestionId(definition: SurveyDefinition): string | null {
  const question = definition.questions.find((q) =>
    ["single_choice", "multi_choice", "dropdown", "rating_5", "nps", "satisfaction_5"].includes(q.type),
  );
  return question?.id ?? null;
}

/**
 * POST /api/survey-responses
 *
 * Records a full set of answers to a multi-question survey. Like the old
 * `/api/responses`, this is a public surface, so the route carries the
 * defensive load: session-token auth, strict validation, rate limiting, and
 * validation of every answer against the survey's own rules.
 *
 * The old single-question route is deliberately untouched, so the deployed
 * extension keeps working through the transition.
 */

const MAX_BODY_BYTES = 16_384;
const MAX_ANSWERS = 10;

const answerSchema = z.object({
  questionId: z.string().min(1).max(64),
  optionIds: z.array(z.string().min(1).max(128)).max(20).optional(),
  numberValue: z.number().int().nullable().optional(),
  textValue: z.string().max(500).nullable().optional(),
  otherText: z.string().max(500).nullable().optional(),
});

const bodySchema = z.object({
  surveyId: z.string().min(1).max(64),
  /** The published version the buyer answered (from the compiled config). */
  surveyVersion: z.number().int().min(0).optional(),
  orderId: orderIdSchema.optional().nullable(),
  placement: z.enum(PLACEMENTS).optional(),
  locale: z.string().max(32).optional().nullable(),
  /** T8: numeric product ids on the order's lines. */
  productIds: z.array(z.string().min(1).max(64)).max(10).optional(),
  answers: z.array(answerSchema).min(1).max(MAX_ANSWERS),
});

/** The browser preflights every submit; answer OPTIONS with a CORS 204. */
export const loader = async ({ request }: { request: Request }) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(
    toResponse({ error: { code: "method_not_allowed" } }, { status: 405, headers: { Allow: "POST, OPTIONS" } }),
  );
};

export const action = async ({ request }: { request: Request }) => {
  const requestId = `ans_${Date.now().toString(36)}`;

  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shopDomain = sessionToken.dest.toLowerCase();

  try {
    const text = await readBodyText(request, MAX_BODY_BYTES);
    if (text === null) {
      throw new ValidationError("The request body was too large.", "Reload the page and try again.");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ValidationError("The request body was not valid JSON.", "Reload the page and try again.");
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Some answers were missing or invalid.", "Please answer again and resubmit.", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }

    const orderId = parsed.data.orderId ?? null;
    const placement: Placement = parsed.data.placement ?? "thank_you";

    // The Thank-you and Order-status pages always have an order. Without one the
    // per-order duplicate guard cannot apply (NULL order ids are distinct), so an
    // id-less checkout submission is refused rather than written unbounded.
    if (!orderId && (placement === "thank_you" || placement === "order_status")) {
      throw new ValidationError("An order id is required.", "Reload the page and try again.", { field: "orderId" });
    }

    // Per session token, before anything else that costs a database read: one
    // lifted checkout token cannot be reused to write many forged orders. Only
    // stored answers count (recorded below), so failed attempts never burn it.
    const tokenKey = `token:${shopDomain}:${sessionToken.jti ?? sessionToken.sub ?? "anon"}`;
    checkTokenSubmission(tokenKey);
    consumeToken(`answer:${shopDomain}:${orderId ?? "none"}`, BUCKETS.response);
    // The shop-wide backstop applies to every submission. Only a real order
    // Shopify told us about is exempt; an id-less one never is.
    await consumeShopBackstop(`answer-shop:${shopDomain}`, BUCKETS.responseShop, () =>
      orderId ? isKnownOrder(shopDomain, orderId) : Promise.resolve(false),
    );

    const shop = await findShopByDomain(shopDomain);
    if (!shop || shop.installState === "uninstalled") {
      throw new ValidationError("This store is not using SourceTrac.", "Contact the store if you see this message.");
    }

    const row = await getSurveyRow(shop.id, parsed.data.surveyId);
    if (!row) {
      throw new ValidationError("That survey is no longer available.", "Please reload the page.");
    }

    // Buyers are only ever served a live survey on one of its placements. A
    // paused survey still accepts answers already in flight (learn-and-stop can
    // pause it between the buyer's load and submit); a draft or archived one,
    // or a placement it is not on, never had a buyer.
    const publishedPlacements = rowToEditor(row, { view: "published" }).placements;
    if ((row.status !== "active" && row.status !== "paused") || !publishedPlacements.includes(placement)) {
      throw new ValidationError("That survey is no longer available.", "Please reload the page.");
    }

    // Validate against the PUBLISHED survey the buyer was served, never the
    // merchant's unpublished draft.
    const editor = rowToEditor(row, { view: "published" });
    const definition = {
      id: editor.id,
      name: editor.name,
      title: editor.title,
      intro: editor.intro,
      buttonLabel: editor.buttonLabel,
      thankYouText: editor.thankYouText,
      layout: editor.layout,
      questions: editor.questions,
    };

    const result = await submitAnswers({
      shopId: shop.id,
      surveyId: row.id,
      currentVersion: row.version,
      surveyVersion: Math.min(parsed.data.surveyVersion ?? row.version, row.version),
      orderId,
      placement,
      locale: parsed.data.locale ?? null,
      productIds: parsed.data.productIds,
      answers: parsed.data.answers as AnswerInput[],
      plan: effectivePlan(shop),
      definition,
      syncOptions: row.syncOptions,
      learnAndStop: row.learnAndStop,
      mainQuestionId: mainQuestionId(definition),
    });

    if (result.outcome === "invalid") {
      logger.warn("answer_rejected_invalid", {
        request_id: requestId,
        shop_domain: shopDomain,
        survey_id: row.id,
        issues: result.issues,
      });
      throw new ValidationError("Those answers were not valid.", "Please answer again and resubmit.", {
        issues: result.issues,
      });
    }

    if (result.outcome === "created") {
      recordTokenSubmission(tokenKey, (sessionToken.exp ?? 0) * 1000);
    }

    logger.info("answer_accepted", {
      request_id: requestId,
      shop_domain: shopDomain,
      survey_id: row.id,
      outcome: result.outcome,
      is_locked: result.isLocked,
    });

    // A duplicate is a success: the buyer has answered and should see the
    // confirmation either way.
    return cors(toResponse(data({ ok: true, counted: result.counted })));
  } catch (error) {
    const { status, body } = serialiseError(error, {
      request_id: requestId,
      shop_domain: shopDomain,
      route: "api_survey_responses",
    });
    return cors(toResponse(body, { status }));
  }
};
