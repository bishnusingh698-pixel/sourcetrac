import { data } from "react-router";
import { z } from "zod";

import { orderIdSchema } from "~/lib/settings";

import { readBodyText, toResponse } from "~/lib/http.server";
import { serialiseError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { effectivePlan } from "~/lib/plans";
import { BUCKETS, consumeToken } from "~/lib/rate-limit.server";
import { submitResponse } from "~/lib/responses.server";
import { DEFAULT_OPTIONS, OTHER_CHANNEL_VALUE, parseSurveySettings } from "~/lib/settings";
import { findShopByDomain } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * POST /api/responses
 *
 * Records a buyer's answer. This is a public surface, so the route carries the
 * defensive load: session-token auth, strict validation, rate limiting, and an
 * allowlist check that the submitted channel is one the merchant configured.
 *
 * The allowlist check matters. Without it, anyone could POST arbitrary strings
 * and poison the merchant's channel analytics.
 */

const MAX_OTHER_LENGTH = 140;
const MAX_BODY_BYTES = 4096;

const bodySchema = z.object({
  orderId: orderIdSchema,
  channel: z.string().min(1).max(64),
  otherText: z.string().max(MAX_OTHER_LENGTH).optional().nullable(),
  locale: z.string().max(32).optional().nullable(),
});

/**
 * The browser preflights every submit with an OPTIONS request (it carries an
 * Authorization header and a JSON body). React Router sends OPTIONS to the
 * loader, and with no loader here it answered 400 without CORS headers, so the
 * browser blocked every answer before the POST was sent.
 * `authenticate.public.checkout` answers OPTIONS itself with a CORS 204; any
 * other non-POST request gets a CORS-wrapped 405.
 */
export const loader = async ({ request }: { request: Request }) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(toResponse({ error: { code: "method_not_allowed" } }, { status: 405, headers: { Allow: "POST, OPTIONS" } }));
};

export const action = async ({ request }: { request: Request }) => {
  const requestId = `resp_${Date.now().toString(36)}`;

  // Throws a 401 Response for a missing/invalid/expired token. That must keep
  // propagating untouched: the library builds its own CORS headers for it.
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shopDomain = sessionToken.dest.toLowerCase();

  // Everything after this point returns a CORS-wrapped response, including
  // failures. A thrown error would be turned into a response by React Router,
  // which cannot set `Access-Control-Allow-Origin`, so the extension would read
  // a genuine 400 as an opaque network failure and retry it.
  try {
    // A real answer is well under 1 KB; 4 KB leaves room for a long "Other"
    // text in a multi-byte script.
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
      throw new ValidationError("Some answers were missing or invalid.", "Please choose one option and try again.", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }

    // Rate limit after validation, so a malformed flood cannot exhaust the token
    // bucket that legitimate buyers depend on.
    const usesOther = parsed.data.channel === OTHER_CHANNEL_VALUE;
    // Shop-wide first: the per-order key below is chosen by the caller, so on
    // its own it cannot stop a flood of made-up order ids.
    consumeToken(`response-shop:${shopDomain}`, BUCKETS.responseShop);
    consumeToken(
      `response:${shopDomain}:${parsed.data.orderId}`,
      usesOther ? BUCKETS.otherResponse : BUCKETS.response,
    );

    // Looked up only after validation and rate limiting, so neither a malformed
    // flood nor a throttled one reaches the database (and wakes Neon, whose
    // free compute hours are the scarcest resource this app has).
    const shop = await findShopByDomain(shopDomain);
    if (!shop || shop.installState === "uninstalled") {
      throw new ValidationError("This store is not using SourceTrac.", "Contact the store if you see this message.");
    }

    // No plan gate: a request here means Shopify rendered the block, and
    // refusing would drop an answer the buyer already gave.

    const settings = parseSurveySettings(shop.optionsJson, {
      questionText: shop.questionText,
      options: DEFAULT_OPTIONS,
      allowOther: shop.allowOther,
    });

    // --- allowlist: the channel must be one the merchant configured ---
    const isKnownOption = settings.options.some((option) => option.value === parsed.data.channel);
    const isOther = parsed.data.channel === OTHER_CHANNEL_VALUE;

    if (isOther && !settings.allowOther) {
      throw new ValidationError("This store does not accept an “Other” answer.", "Please choose one of the listed options.", {
        field: "channel",
      });
    }

    if (!isKnownOption && !isOther) {
      logger.warn("response_channel_not_in_allowlist", {
        request_id: requestId,
        shop_domain: shopDomain,
        channel: parsed.data.channel,
      });
      throw new ValidationError("That answer is not one of the available options.", "Please choose one of the listed options.", {
        field: "channel",
      });
    }

    const otherText = isOther ? parsed.data.otherText?.trim() || null : null;
    // A cancelled, declined or expired subscription must not keep unlimited paid
    // behaviour. `planStatusIsCollecting` is the single place that decides whether
    // a recorded plan status still grants paid access.
    const plan = effectivePlan(shop);

    const result = await submitResponse({
      shopId: shop.id,
      orderId: parsed.data.orderId,
      channel: parsed.data.channel,
      otherText,
      locale: parsed.data.locale ?? null,
      plan,
    });

    logger.info("response_accepted", {
      request_id: requestId,
      shop_domain: shopDomain,
      outcome: result.outcome,
      is_locked: result.isLocked,
    });

    // A duplicate is a success. The buyer has answered and should see the
    // confirmation either way — surfacing an error would be a false failure.
    return cors(
      toResponse(data({
        ok: true,
        // At the free cap the answer IS stored and flagged as locked. The buyer
        // is told it counted, because it did; the merchant sees the upgrade
        // prompt. We never silently discard a buyer's answer.
        counted: !result.isLocked,
      })),
    );
  } catch (error) {
    // serialiseError logs once and returns a body with no stack, SQL or upstream
    // detail. 400s tell the extension to stop retrying; 5xx tell it to try again.
    const { status, body } = serialiseError(error, {
      request_id: requestId,
      shop_domain: shopDomain,
      route: "api_responses",
    });
    return cors(toResponse(body, { status }));
  }
};
