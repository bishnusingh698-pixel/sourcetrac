/**
 * Shared shapes and parsers for the shop's channel options and the ids the
 * checkout blocks send.
 *
 * `SurveyOption` / `DEFAULT_OPTIONS` describe the original single-question
 * survey stored on the shop row. Nothing edits or serves it any more, but its
 * labels still name the channels of answers given before the multi-question
 * survey, so analytics reads them (`parseSurveySettings`).
 */

import { z } from "zod";

export type SurveyOption = {
  /** Stable machine key. What we store and aggregate by. */
  value: string;
  /** What the buyer sees. Merchant-editable. */
  label: string;
  /** Optional single emoji, stored alongside the label. */
  emoji: string | null;
};

export type SurveySettings = {
  questionText: string;
  options: SurveyOption[];
  allowOther: boolean;
};

/** Slugify a label into a stable, collision-checked channel value. */
export function slugifyChannel(label: string, existing: Set<string>): string {
  // Letters and digits from any script survive. The old `[^a-z0-9]` pattern
  // reduced every Chinese, Japanese, Cyrillic or Greek label to the fallback
  // "channel", so the second such option was rejected as a duplicate and a
  // merchant could not write their survey in their own language.
  //
  // NFKD then stripping combining accents turns "é" into "e", keeping Latin
  // slugs exactly as before. NFC afterwards recomposes the marks that were not
  // stripped, such as Japanese dakuten, so "ブ" stays distinct from "フ".
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // Sliced by code point so a character outside the BMP is never cut in half.
  const base = Array.from(slug).slice(0, 40).join("").replace(/-+$/, "") || "channel";

  if (!existing.has(base)) return base;

  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * A translatable piece of text: an i18next key plus its interpolation values.
 * Actions return these rather than English, and the page calls `t()`.
 */
export type I18nText = { key: string; params?: Record<string, string | number> };

export function parseSurveySettings(json: string | null | undefined, fallback: SurveySettings): SurveySettings {
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const options = parsed.filter(
      (o): o is SurveyOption =>
        typeof o === "object" && o !== null && typeof (o as SurveyOption).value === "string",
    );
    return {
      questionText: fallback.questionText,
      options: options.length > 0 ? options : fallback.options,
      allowOther: fallback.allowOther,
    };
  } catch {
    // A corrupt row must not break the reports: fall back to the defaults.
    return fallback;
  }
}

export const DEFAULT_OPTIONS: SurveyOption[] = [
  { value: "google", label: "Google search", emoji: null },
  { value: "instagram", label: "Instagram", emoji: null },
  { value: "facebook", label: "Facebook", emoji: null },
  { value: "tiktok", label: "TikTok", emoji: null },
  { value: "friend-or-family", label: "Friend or family", emoji: null },
  { value: "in-store", label: "In store", emoji: null },
];

export const OTHER_CHANNEL_VALUE = "other";

/**
 * Order GIDs the checkout surfaces hand an extension.
 *
 * Thank-you's `orderConfirmation.order.id` is `gid://shopify/OrderIdentity/<n>`
 * and Order status's `order.id` is `gid://shopify/Order/<n>`. Both carry the
 * same numeric id the order webhooks use, so the trailing number is the order.
 */
const ORDER_GID = /^gid:\/\/shopify\/(?:Order|OrderIdentity)\/(\d+)$/;

/** The numeric order id inside an order GID, or the input unchanged. */
export function normaliseOrderId(raw: string): string {
  return ORDER_GID.exec(raw)?.[1] ?? raw;
}

/**
 * Order id accepted from the extension endpoints, normalised to numeric.
 *
 * Shared because two things have to agree and neither can enforce it alone: the
 * routes must store an order id in the same shape `orders/create` writes. The
 * webhook stores `String(order.id)` from the REST Admin API payload, which is
 * numeric. The extensions send GIDs (see `ORDER_GID`), and the ui-extensions
 * type only says `id: string`, so the type system cannot catch a mismatch.
 *
 * This once accepted digits only and rejected every GID with a 422, a
 * permanent failure the extension answers by hiding itself: no buyer ever
 * saw the survey. Rejecting the GID would hide it again; storing it raw would
 * write an id no `OrderCache` row can match, so the answer stays "Pending"
 * and its revenue never reaches the dashboard. Both are pinned by
 * tests/unit/order-id.test.ts.
 */
export const orderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .transform(normaliseOrderId)
  .pipe(z.string().regex(/^\d+$/, "orderId must be numeric"));

/**
 * A survey id as a merchant pastes it into a checkout block's "Survey ID"
 * setting: trimmed and lower-cased. Anything that is not an id (a survey name,
 * a stray character) parses to `undefined` instead of failing the request, so
 * a bad setting falls back to the normal pick rather than hiding the survey.
 */
export const surveyIdSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9]{8,40}$/))
  .optional()
  .catch(undefined);
