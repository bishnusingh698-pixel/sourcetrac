/**
 * Survey settings: question text, options, and the "Other" toggle.
 *
 * Validation is pure so it can be unit-tested without a database, and so the
 * Settings route and the /public/survey-config route cannot disagree about
 * what a valid survey is.
 */

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
const EMOJI_MAX_LENGTH = 12;

/** Slugify a label into a stable, collision-checked channel value. */
export function slugifyChannel(label: string, existing: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "channel";

  if (!existing.has(base)) return base;

  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function validateQuestionText(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("Question text is required.", "Type a question to ask your buyers.", {
      field: "question_text",
    });
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Question text is required.", "Type a question to ask your buyers.", {
      field: "question_text",
    });
  }
  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(
      `Question text must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
      `Shorten it by ${trimmed.length - MAX_QUESTION_LENGTH} characters.`,
      { field: "question_text", length: trimmed.length },
    );
  }
  return trimmed;
}

function validateOptionLabel(raw: unknown, index: number): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ValidationError(`Answer option ${index + 1} is empty.`, "Give every option a label, or delete it.", {
      field: `options.${index}.label`,
    });
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length > MAX_OPTION_LABEL_LENGTH) {
    throw new ValidationError(
      `Answer option ${index + 1} is too long.`,
      `Keep it to ${MAX_OPTION_LABEL_LENGTH} characters or fewer.`,
      { field: `options.${index}.label` },
    );
  }
  return trimmed;
}

function validateEmoji(raw: unknown, index: number): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ValidationError(`Emoji on option ${index + 1} is not valid.`, "Use a single emoji, or leave it blank.", {
      field: `options.${index}.emoji`,
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length > EMOJI_MAX_LENGTH || !EMOJI_PATTERN.test(trimmed)) {
    throw new ValidationError(
      `Emoji on option ${index + 1} is not valid.`,
      "Use a single emoji, or leave it blank.",
      { field: `options.${index}.emoji` },
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
    throw new ValidationError("Answer options are missing.", "Add at least 6 answer options.", {
      field: "options",
    });
  }

  if (input.options.length < MIN_OPTIONS) {
    throw new ValidationError(
      `Add at least ${MIN_OPTIONS} answer options.`,
      `You have ${input.options.length}. Add ${MIN_OPTIONS - input.options.length} more.`,
      { field: "options", count: input.options.length, minimum: MIN_OPTIONS },
    );
  }

  if (input.options.length > MAX_OPTIONS) {
    throw new ValidationError(
      `Use at most ${MAX_OPTIONS} answer options.`,
      `Remove ${input.options.length - MAX_OPTIONS} to continue.`,
      { field: "options", count: input.options.length, maximum: MAX_OPTIONS },
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
    const value = previousBySlug.get(slug) ?? slugifyChannel(label, taken);

    if (taken.has(value)) {
      throw new ValidationError(
        `Two options are the same: "${label}".`,
        "Make each answer option distinct.",
        { field: `options.${index}.label` },
      );
    }
    taken.add(value);
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

export const OTHER_CHANNEL_VALUE = "other";
