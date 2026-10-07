/**
 * Survey settings: question text, options, and the "Other" toggle.
 *
 * Validation is pure so it can be unit-tested without a database, and so the
 * Settings route and the /public/survey-config route cannot disagree about
 * what a valid survey is.
 */

import { z } from "zod";

import { ValidationError } from "./errors";

export const MIN_OPTIONS = 6;
export const MAX_OPTIONS = 10;
export const MAX_QUESTION_LENGTH = 120;
export const MAX_OPTION_LABEL_LENGTH = 60;

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

/** Emoji are multi-codepoint (skin tones, ZWJ sequences, flags). */
const EMOJI_PATTERN = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{1F3FB}-\u{1F3FF}])*$/u;

/**
 * Exported so the Settings form's `maxLength` can be bound to it. A ZWJ family
 * sequence is 7 code points and a flag is 8, so a tighter client-side cap silently
 * blocked emoji the server would have accepted.
 */
export const EMOJI_MAX_LENGTH = 12;

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
  // Existing options are unaffected either way: `validateSurveySettings` maps
  // an unchanged label back to its stored value.
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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
 *
 * Validation runs on the server, but the merchant reads the result in their own
 * language. Each error therefore carries the keys for its message and hint
 * alongside the English text, which stays for logs and API callers.
 */
export type I18nText = { key: string; params?: Record<string, string | number> };
export type ValidationI18n = { message: I18nText; hint?: I18nText };

function invalid(
  field: string,
  english: { message: string; hint: string },
  i18n: ValidationI18n,
  extra: Record<string, unknown> = {},
): ValidationError {
  return new ValidationError(english.message, english.hint, { field, ...extra, i18n });
}

/** The translation keys attached to a validation error, if it has any. */
export function validationI18n(error: ValidationError): ValidationI18n | null {
  const value = error.fields.i18n as ValidationI18n | undefined;
  return value && typeof value.message?.key === "string" ? value : null;
}

const QUESTION_REQUIRED = {
  message: { key: "validation.question_required" },
  hint: { key: "validation.question_required_hint" },
};

function validateQuestionText(raw: unknown): string {
  const required = { message: "Question text is required.", hint: "Type a question to ask your buyers." };
  if (typeof raw !== "string") {
    throw invalid("questionText", required, QUESTION_REQUIRED);
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) {
    throw invalid("questionText", required, QUESTION_REQUIRED);
  }
  if (trimmed.length > MAX_QUESTION_LENGTH) {
    const over = trimmed.length - MAX_QUESTION_LENGTH;
    throw invalid(
      "questionText",
      {
        message: `Question text must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
        hint: `Shorten it by ${over} characters.`,
      },
      {
        message: { key: "validation.question_too_long", params: { max: MAX_QUESTION_LENGTH } },
        hint: { key: "validation.question_too_long_hint", params: { count: over } },
      },
      { length: trimmed.length },
    );
  }
  return trimmed;
}

function validateOptionLabel(raw: unknown, index: number): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw invalid(
      `options.${index}.label`,
      { message: `Answer option ${index + 1} is empty.`, hint: "Give every option a label, or delete it." },
      { message: { key: "validation.label_required" }, hint: { key: "validation.label_required_hint" } },
    );
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length > MAX_OPTION_LABEL_LENGTH) {
    throw invalid(
      `options.${index}.label`,
      {
        message: `Answer option ${index + 1} is too long.`,
        hint: `Keep it to ${MAX_OPTION_LABEL_LENGTH} characters or fewer.`,
      },
      {
        message: { key: "validation.label_too_long", params: { max: MAX_OPTION_LABEL_LENGTH } },
        hint: {
          key: "validation.label_too_long_hint",
          params: { count: trimmed.length - MAX_OPTION_LABEL_LENGTH },
        },
      },
    );
  }
  return trimmed;
}

function validateEmoji(raw: unknown, index: number): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (typeof raw !== "string" || trimmed.length > EMOJI_MAX_LENGTH || !EMOJI_PATTERN.test(trimmed)) {
    throw invalid(
      `options.${index}.emoji`,
      { message: `Emoji on option ${index + 1} is not valid.`, hint: "Use a single emoji, or leave it blank." },
      { message: { key: "validation.emoji_invalid" }, hint: { key: "validation.emoji_invalid_hint" } },
    );
  }
  return trimmed;
}

/**
 * Validate and normalise merchant input.
 *
 * Options are re-slugged on every save so `value` always matches `label`. That
 * means renaming a channel re-keys historical data. To avoid that, callers pass
 * the existing options; a label whose slug is unchanged keeps its original
 * value, and only genuinely new labels get a fresh slug.
 */
export function validateSurveySettings(
  input: { questionText: unknown; options: unknown; allowOther: unknown },
  existing: SurveyOption[] = [],
): SurveySettings {
  const questionText = validateQuestionText(input.questionText);
  const allowOther = input.allowOther === true;

  if (!Array.isArray(input.options)) {
    throw invalid(
      "options",
      { message: "Answer options are missing.", hint: `Add at least ${MIN_OPTIONS} answer options.` },
      { message: { key: "validation.options_invalid" }, hint: { key: "validation.options_invalid_hint" } },
    );
  }

  if (input.options.length < MIN_OPTIONS) {
    const count = input.options.length;
    throw invalid(
      "options",
      { message: `Add at least ${MIN_OPTIONS} answer options.`, hint: `You have ${count}. Add ${MIN_OPTIONS - count} more.` },
      {
        message: { key: "validation.options_too_few", params: { min: MIN_OPTIONS } },
        hint: { key: "validation.options_too_few_hint", params: { count, needed: MIN_OPTIONS - count } },
      },
      { count, minimum: MIN_OPTIONS },
    );
  }

  if (input.options.length > MAX_OPTIONS) {
    const count = input.options.length;
    throw invalid(
      "options",
      { message: `Use at most ${MAX_OPTIONS} answer options.`, hint: `Remove ${count - MAX_OPTIONS} to continue.` },
      {
        message: { key: "validation.options_too_many", params: { max: MAX_OPTIONS } },
        hint: { key: "validation.options_too_many_hint", params: { count: count - MAX_OPTIONS } },
      },
      { count, maximum: MAX_OPTIONS },
    );
  }

  const previousBySlug = new Map<string, string>();
  for (const option of existing) {
    previousBySlug.set(slugifyChannel(option.label, new Set()), option.value);
  }

  const taken = new Set<string>();
  const options: SurveyOption[] = [];

  input.options.forEach((rawOption, index) => {
    const raw = (rawOption ?? {}) as { label?: unknown; emoji?: unknown };
    const label = validateOptionLabel(raw.label, index);
    const emoji = validateEmoji(raw.emoji, index);

    // Prefer the existing value when the slug is unchanged, so historical
    // responses keep pointing at the right channel after a rename.
    const slug = slugifyChannel(label, new Set());
    const value = previousBySlug.get(slug) ?? slug;

    // Compare the raw slug, not the de-duplicated value. Checking `taken` after
    // slugifyChannel had already salted the collision would never match, which
    // silently let "Instagram" and "instagram" become two separate channels
    // and split the same source's revenue across two rows.
    if (taken.has(slug)) {
      throw invalid(
        `options.${index}.label`,
        { message: `Two options are the same: "${label}".`, hint: "Make each answer option distinct." },
        { message: { key: "validation.duplicate_channel" }, hint: { key: "validation.duplicate_channel_hint" } },
      );
    }
    taken.add(slug);
    options.push({ value, label, emoji });
  });

  return { questionText, options, allowOther };
}

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
    // A corrupt settings row must not break the survey for buyers. Fall back
    // to defaults and log; the merchant can re-save from Settings.
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

/** Must match the `questionText` default in `prisma/schema.prisma`. */
export const DEFAULT_QUESTION_TEXT = "How did you hear about us?";

/**
 * Whether a shop's survey is still exactly the English defaults it was
 * installed with.
 *
 * New shops are seeded in English whatever the merchant's language, so a
 * German store shows German buyers an English question until someone edits
 * it. The Survey page uses this to offer the defaults in the merchant's own
 * language. Emoji are ignored: adding one is not rewording.
 */
export function isUntouchedDefaultSurvey(questionText: string, options: ReadonlyArray<SurveyOption>): boolean {
  return (
    questionText === DEFAULT_QUESTION_TEXT &&
    options.length === DEFAULT_OPTIONS.length &&
    options.every(
      (option, index) =>
        option.value === DEFAULT_OPTIONS[index]?.value && option.label === DEFAULT_OPTIONS[index]?.label,
    )
  );
}

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
