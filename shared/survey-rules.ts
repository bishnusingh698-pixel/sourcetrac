/**
 * Shared survey rules — the single source of truth for limits, validation,
 * show-if logic, option ordering and scoring.
 *
 * The admin, the server and both checkout extensions import this module, so the
 * rules cannot drift between what the merchant is allowed to save, what the API
 * accepts, and what the buyer sees.
 *
 * Dependency-free by design. This file is bundled into each checkout UI
 * extension, which has a 64 KB compressed budget, so it must not import zod,
 * Prisma, i18next or any other package. The server may wrap these functions in
 * a schema library, but the rules themselves live here.
 */

export const QUESTION_TYPES = [
  "single_choice", // pick one
  "multi_choice", // pick several
  "dropdown", // pick one from a dropdown
  "yes_no", // Yes / No
  "rating_5", // 1–5 stars
  "satisfaction_5", // Very dissatisfied … Very satisfied
  "nps", // 0–10
  "text", // free text (single line or multi line)
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export const LIMITS = {
  MIN_OPTIONS: 2,
  MAX_OPTIONS: 10,
  MAX_QUESTIONS: 5,
  RECOMMENDED_MAX_QUESTIONS: 3, // editor shows a soft warning above this
  MAX_TEXT_ANSWER: 500, // characters, for text answers and "Other"
  MAX_QUESTION_TEXT: 200,
  MAX_HELP_TEXT: 200,
  MAX_OPTION_LABEL: 80,
  MAX_SURVEY_TITLE: 80,
  MAX_INTRO_TEXT: 200,
  MAX_THANK_YOU_TEXT: 200,
  MAX_BUTTON_LABEL: 30,
  MAX_SURVEY_NAME: 80, // internal name, merchant-only
  MAX_SURVEYS_TOTAL: 50,
  MAX_TARGET_PRODUCTS: 50,
  MAX_TARGET_COLLECTIONS: 10,
  // One survey as the checkout block downloads it. Raised from 16 KB when
  // templates began shipping their wording in all ten languages.
  MAX_COMPILED_CONFIG_BYTES: 32_000,
  /** S12: a scale label's character limit. */
  MAX_SCALE_LABEL: 30,
} as const;

/**
 * Design settings the checkout components can really support (S11, S12).
 *
 * Fonts and colours always come from the merchant's Shopify checkout settings,
 * so there is deliberately no colour here for the checkout placements. The
 * bonus placements (on-site, link page) use our own scoped styles and carry
 * their own accent colour separately.
 */
export type DesignSettings = {
  /** all = every question at once; one_by_one = one question per step. */
  layout: "all" | "one_by_one";
  /** Show "1 of 3" (one-at-a-time only). */
  showProgress: boolean;
  /** Show the survey title. */
  showTitle: boolean;
  /** rating_5 rendering. */
  ratingStyle: "numbers" | "stars";
  /** S12 low/high labels under rating and NPS scales. */
  scaleLowLabel: string;
  scaleHighLabel: string;
  /** Card presentation. */
  cardBorder: "border" | "no_border";
  spacing: "compact" | "comfortable";
};

export const DEFAULT_DESIGN: DesignSettings = {
  layout: "all",
  showProgress: true,
  showTitle: true,
  ratingStyle: "numbers",
  // S12 defaults, from Appendix B of the upgrade plan.
  scaleLowLabel: "Very poor",
  scaleHighLabel: "Excellent",
  cardBorder: "border",
  spacing: "comfortable",
};

/** Default scale labels for an NPS question (unlike rating_5's poor/excellent). */
export const DEFAULT_NPS_SCALE = { low: "Not likely", high: "Very likely" } as const;

/** Fill a partial design with every default, so a stored design is always complete. */
export function resolveDesign(partial?: Partial<DesignSettings> | null): DesignSettings {
  return { ...DEFAULT_DESIGN, ...(partial ?? {}) };
}

/** The free-text channel. Must match `OTHER_CHANNEL_VALUE` in app/lib/settings.ts. */
export const OTHER_CHANNEL_VALUE = "other";

/** Types whose answer options the merchant authors. The rest have fixed options. */
export const MERCHANT_OPTION_TYPES: readonly QuestionType[] = ["single_choice", "multi_choice", "dropdown"];

/** Types the buyer answers by choosing from a fixed or merchant list. */
export const CHOICE_TYPES: readonly QuestionType[] = [
  "single_choice",
  "multi_choice",
  "dropdown",
  "yes_no",
  "satisfaction_5",
];

/** Types whose show-if condition is a numeric range rather than a set of options. */
export const NUMERIC_TYPES: readonly QuestionType[] = ["rating_5", "nps"];

/** Yes / No is stored as a number: yes = 1, no = 0 (Appendix C). */
export const YES_NO_IDS = { yes: "yes", no: "no" } as const;
export const YES_NO_VALUE = { yes: 1, no: 0 } as const;

/** The five satisfaction options, in order. Stable IDs; values 1–5. */
export const SATISFACTION_OPTIONS = [
  { id: "very_dissatisfied", value: 1 },
  { id: "dissatisfied", value: 2 },
  { id: "neutral", value: 3 },
  { id: "satisfied", value: 4 },
  { id: "very_satisfied", value: 5 },
] as const;

export function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === "string" && (QUESTION_TYPES as readonly string[]).includes(value);
}

export function questionHasMerchantOptions(type: QuestionType): boolean {
  return MERCHANT_OPTION_TYPES.includes(type);
}

export function isChoiceType(type: QuestionType): boolean {
  return CHOICE_TYPES.includes(type);
}

export function isNumericType(type: QuestionType): boolean {
  return NUMERIC_TYPES.includes(type);
}

/** Satisfaction option id -> its 1–5 value, or undefined. */
export function satisfactionValue(id: string): number | undefined {
  return SATISFACTION_OPTIONS.find((o) => o.id === id)?.value;
}

/**
 * The fixed answer options for a question type that has them (Yes / No and the
 * five satisfaction levels). Merchant-authored types return `[]`.
 *
 * `resolveOptions` covers only the merchant's own options, so a show-if rule on
 * a Yes / No or satisfaction question — whose ids are the stable `yes`/`no` and
 * `very_dissatisfied`…`very_satisfied` values — needs this to be recognised.
 */
export function fixedOptions(question: SurveyQuestionDef): SurveyOptionDef[] {
  if (question.type === "yes_no") {
    return [
      { id: YES_NO_IDS.yes, label: "Yes" },
      { id: YES_NO_IDS.no, label: "No" },
    ];
  }
  if (question.type === "satisfaction_5") {
    return SATISFACTION_OPTIONS.map((option) => ({ id: option.id, label: option.id }));
  }
  return [];
}

/**
 * Every option id a show-if condition may reference for `question`: the
 * merchant's options (archived included) for merchant types, the fixed options
 * otherwise. This is the set `validateSurveyDefinition` checks against.
 */
export function showIfOptionIds(question: SurveyQuestionDef): Set<string> {
  if (questionHasMerchantOptions(question.type)) {
    return new Set(resolveOptions(question, { includeArchived: true }).map((o) => o.id));
  }
  return new Set(fixedOptions(question).map((o) => o.id));
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type SurveyOptionDef = {
  /** Stable id. Never reused or renumbered; what answers reference. */
  id: string;
  label: string;
  /** True for the synthetic "Other (please specify)" option. Always last. */
  isOther?: boolean;
  /** T6: selecting it clears the others, and selecting any other clears it. */
  exclusive?: boolean;
  /** Hidden from shoppers, still shown in results as "(removed) Label". */
  archived?: boolean;
  /** locale -> translated label. */
  translations?: Record<string, string | undefined>;
};

export type ShowIf = {
  questionId: string;
  /** Condition on a choice question: answered with any of these option ids. */
  optionIds?: string[];
  /** Condition on a numeric question: value within [min, max]. */
  min?: number;
  max?: number;
};

export type QuestionTranslation = {
  text?: string;
  helpText?: string;
  placeholder?: string;
};

export type SurveyQuestionDef = {
  id: string;
  type: QuestionType;
  text: string;
  helpText?: string | null;
  placeholder?: string | null;
  /** For `text`: single-line when false, multi-line when true. */
  textMultiline?: boolean;
  required?: boolean;
  randomizeOptions?: boolean;
  allowOther?: boolean;
  minSelections?: number | null;
  maxSelections?: number | null;
  showIf?: ShowIf | null;
  options?: SurveyOptionDef[];
  archived?: boolean;
  translations?: Record<string, QuestionTranslation | undefined>;
};

export type SurveyDefinition = {
  id?: string;
  name?: string;
  title?: string;
  intro?: string | null;
  buttonLabel?: string | null;
  thankYouText?: string | null;
  layout?: "all" | "one_by_one";
  design?: Partial<DesignSettings> | null;
  questions: SurveyQuestionDef[];
};

export type AnswerInput = {
  questionId: string;
  /** Choice answers. One entry for single-choice, several for multiple. */
  optionIds?: string[];
  /** Numeric answers: rating 1–5, NPS 0–10, yes/no 1 or 0. */
  numberValue?: number | null;
  /** Free-text answers. */
  textValue?: string | null;
  /** The typed text when the "Other" option was chosen. */
  otherText?: string | null;
};

export type ValidationIssue = {
  /** Exact field, e.g. `questions[2].options[0].label`. */
  path: string;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Buyer-facing messages (Appendix B)
// ---------------------------------------------------------------------------

export const MESSAGES = {
  required_choice: "Please choose an answer.",
  required_text: "Please write an answer.",
  min_selections: (min: number) => `Please choose at least ${min}.`,
  max_selections: (max: number) => `You can choose up to ${max}.`,
  other_required: "Tell us a bit more, or choose another answer.",
  text_too_long: `Please keep it under ${LIMITS.MAX_TEXT_ANSWER} characters.`,
} as const;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

// ---------------------------------------------------------------------------
// Option resolution and ordering
// ---------------------------------------------------------------------------

/**
 * The full list of choices for a question: the merchant's options, plus the
 * synthetic "Other" when free text is on and the merchant has not already named
 * an option "Other". Archived options are excluded for shoppers.
 */
export function resolveOptions(question: SurveyQuestionDef, { includeArchived = false } = {}): SurveyOptionDef[] {
  const base = (question.options ?? []).filter((o) => includeArchived || !o.archived);
  const options = [...base];
  if (question.allowOther && !options.some((o) => o.isOther)) {
    options.push({ id: OTHER_CHANNEL_VALUE, label: "Other (please specify)", isOther: true });
  }
  return options;
}

/** djb2-ish string hash, used to seed the shuffle and the sampling. */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG. Same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Answer options in display order.
 *
 * When randomization is on the non-"Other" options are shuffled with a
 * Fisher–Yates shuffle seeded by `seed` (derived from the order id), so the
 * order is stable for one shopper and identical on the Thank-you and
 * Order-status pages. "Other" is always last.
 */
export function orderOptions<T>(
  options: readonly T[],
  randomize: boolean,
  seed: string,
): T[] {
  const other = options.filter((o) => (o as { isOther?: boolean }).isOther);
  const rest = options.filter((o) => !(o as { isOther?: boolean }).isOther);
  if (!randomize || rest.length < 2) return [...rest, ...other];

  const rand = mulberry32(hashSeed(seed));
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = shuffled[i] as T;
    const b = shuffled[j] as T;
    shuffled[i] = b;
    shuffled[j] = a;
  }
  return [...shuffled, ...other];
}

/**
 * T6: reconcile a multiple-choice selection after a tap, applying the exclusive
 * rule.
 *
 * The controls (`s-choice-list`) report the *whole* new value array, not which
 * option was tapped, so the tapped option is the id in `next` that was not in
 * `previous`. Tapping an exclusive option ("None of these") leaves just it;
 * tapping any other drops the exclusive ones. Without this a buyer could hold an
 * exclusive option *and* another, which `/api/responses` rejects as
 * `exclusive_with_others` — the whole answer would be lost.
 *
 * Pure, so the admin preview, the checkout extension and the tests share one
 * rule. The extension mirrors it in `extensions/shared/src/survey-logic.ts`.
 */
export function reconcileMultiChoiceSelection(
  exclusiveIds: readonly string[],
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const exclusive = new Set(exclusiveIds);
  const added = next.find((id) => !previous.includes(id));
  if (added) {
    return exclusive.has(added) ? [added] : next.filter((id) => !exclusive.has(id));
  }
  // A pure deselection, or no change: what remains was already valid.
  return [...next];
}

/**
 * Whether a question is shown, given the answers so far.
 *
 * A question with no condition is always visible. A condition on a choice
 * question matches when any selected option is in `optionIds`; a condition on a
 * numeric question matches when the value is within `[min, max]`. An unanswered
 * dependency hides the dependent question.
 */
export function isQuestionVisible(
  question: SurveyQuestionDef,
  answersSoFar: readonly AnswerInput[],
): boolean {
  const cond = question.showIf;
  if (!cond) return true;

  const answer = answersSoFar.find((a) => a.questionId === cond.questionId);
  if (!answer) return false;

  if (cond.optionIds && cond.optionIds.length > 0) {
    const selected = answer.optionIds ?? [];
    return selected.some((id) => cond.optionIds?.includes(id));
  }

  if (typeof cond.min === "number" || typeof cond.max === "number") {
    const value = answer.numberValue;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (typeof cond.min === "number" && value < cond.min) return false;
    if (typeof cond.max === "number" && value > cond.max) return false;
    return true;
  }

  // A condition with neither options nor a range can never match.
  return false;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type CountBucket = { value: number; count: number };

/**
 * Net Promoter Score: % promoters (9–10) minus % detractors (0–6), rounded to a
 * whole number. Null when there are no answers — rendered as an em dash, never 0.
 */
export function npsScore(buckets: ReadonlyArray<CountBucket>): number | null {
  let promoters = 0;
  let detractors = 0;
  let total = 0;

  for (const { value, count } of buckets) {
    if (!Number.isFinite(value) || !Number.isFinite(count) || count <= 0) continue;
    total += count;
    if (value >= 9) promoters += count;
    else if (value <= 6) detractors += count;
  }

  if (total === 0) return null;
  return Math.round(((promoters - detractors) / total) * 100);
}

/** The NPS split behind the score, so the page can show where it comes from. */
export type NpsResult = {
  /** −100 to 100. */
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
  total: number;
};

/**
 * Net Promoter Score with its split: promoters answered 9–10, passives 7–8,
 * detractors 0–6. Values outside 0–10 are not NPS answers and are ignored, so a
 * question whose type changed cannot skew the score. Null with no answers.
 */
export function npsResult(buckets: ReadonlyArray<CountBucket>): NpsResult | null {
  const valid = buckets.filter(
    ({ value, count }) => Number.isInteger(value) && value >= 0 && value <= 10 && Number.isFinite(count) && count > 0,
  );
  const sum = (test: (value: number) => boolean) =>
    valid.reduce((total, bucket) => total + (test(bucket.value) ? bucket.count : 0), 0);
  const total = sum(() => true);
  const score = npsScore(valid);
  if (total === 0 || score === null) return null;
  return {
    score,
    promoters: sum((v) => v >= 9),
    passives: sum((v) => v === 7 || v === 8),
    detractors: sum((v) => v <= 6),
    total,
  };
}

/** Customer satisfaction (CSAT) on a 1–5 scale. */
export type CsatResult = {
  /** Share of answers that were 4 or 5, as a whole percent. */
  percent: number;
  satisfied: number;
  total: number;
  /** Mean answer, one decimal place. */
  average: number;
};

/**
 * CSAT: the share of answers that were 4 or 5 on a 1–5 scale ("satisfied" or
 * "very satisfied"), the usual definition. Values outside 1–5 are ignored.
 * Null with no answers, rendered as no score rather than 0%.
 */
export function csatResult(buckets: ReadonlyArray<CountBucket>): CsatResult | null {
  const valid = buckets.filter(
    ({ value, count }) => Number.isInteger(value) && value >= 1 && value <= 5 && Number.isFinite(count) && count > 0,
  );
  const total = valid.reduce((sum, b) => sum + b.count, 0);
  const average = averageRating(valid);
  if (total === 0 || average === null) return null;
  const satisfied = valid.reduce((sum, b) => sum + (b.value >= 4 ? b.count : 0), 0);
  return { percent: Math.round((satisfied / total) * 100), satisfied, total, average };
}

/**
 * Mean of a 1–5 rating distribution, to one decimal place. Null when there are
 * no answers.
 */
export function averageRating(buckets: ReadonlyArray<CountBucket>): number | null {
  let sum = 0;
  let total = 0;

  for (const { value, count } of buckets) {
    if (!Number.isFinite(value) || !Number.isFinite(count) || count <= 0) continue;
    sum += value * count;
    total += count;
  }

  if (total === 0) return null;
  return Math.round((sum / total) * 10) / 10;
}

/**
 * Deterministic order sampling. The same order id always yields the same
 * decision, so the Thank-you and Order-status pages agree, and a survey at 20%
 * is shown to a stable fifth of orders rather than a random subset per page.
 */
export function inSample(orderId: string, percent: number): boolean {
  const p = Number.isFinite(percent) ? percent : 100;
  if (p >= 100) return true;
  if (p <= 0) return false;
  return hashSeed(orderId) % 100 < p;
}

// ---------------------------------------------------------------------------
// Survey definition validation (merchant input)
// ---------------------------------------------------------------------------

function textTooLong(value: string, max: number, path: string, code: string): ValidationIssue | null {
  if (value.length <= max) return null;
  return issue(path, code, `Use ${max} characters or fewer.`);
}

/**
 * Validate a survey definition before it is saved.
 *
 * Returns every problem, each pointing at the exact field so the editor can
 * show it inline. The server is the authority; the editor calls this too so the
 * merchant sees the same errors before saving.
 */
export function validateSurveyDefinition(survey: SurveyDefinition): ValidationIssue[] {
  const errors: ValidationIssue[] = [];

  if (survey.name !== undefined) {
    const e = textTooLong(survey.name, LIMITS.MAX_SURVEY_NAME, "name", "name_too_long");
    if (e) errors.push(e);
  }
  if (survey.title !== undefined) {
    const e = textTooLong(survey.title, LIMITS.MAX_SURVEY_TITLE, "title", "title_too_long");
    if (e) errors.push(e);
  }
  if (typeof survey.intro === "string") {
    const e = textTooLong(survey.intro, LIMITS.MAX_INTRO_TEXT, "intro", "intro_too_long");
    if (e) errors.push(e);
  }
  if (typeof survey.buttonLabel === "string") {
    const e = textTooLong(survey.buttonLabel, LIMITS.MAX_BUTTON_LABEL, "buttonLabel", "button_label_too_long");
    if (e) errors.push(e);
  }
  if (typeof survey.thankYouText === "string") {
    const e = textTooLong(survey.thankYouText, LIMITS.MAX_THANK_YOU_TEXT, "thankYouText", "thank_you_too_long");
    if (e) errors.push(e);
  }

  const questions = survey.questions ?? [];
  if (questions.length === 0) {
    errors.push(issue("questions", "no_questions", "Add at least one question."));
  }
  if (questions.length > LIMITS.MAX_QUESTIONS) {
    errors.push(
      issue("questions", "too_many_questions", `Use at most ${LIMITS.MAX_QUESTIONS} questions.`),
    );
  }

  questions.forEach((question, index) => {
    const base = `questions[${index}]`;

    if (typeof question.text !== "string" || question.text.trim().length === 0) {
      errors.push(issue(`${base}.text`, "question_text_required", "Type a question to ask your buyers."));
    } else {
      const e = textTooLong(question.text, LIMITS.MAX_QUESTION_TEXT, `${base}.text`, "question_text_too_long");
      if (e) errors.push(e);
    }

    if (typeof question.helpText === "string") {
      const e = textTooLong(question.helpText, LIMITS.MAX_HELP_TEXT, `${base}.helpText`, "help_text_too_long");
      if (e) errors.push(e);
    }
    if (typeof question.placeholder === "string") {
      const e = textTooLong(question.placeholder, LIMITS.MAX_HELP_TEXT, `${base}.placeholder`, "placeholder_too_long");
      if (e) errors.push(e);
    }

    if (!isQuestionType(question.type)) {
      errors.push(issue(`${base}.type`, "unknown_type", "That question type is not supported."));
      return;
    }

    if (questionHasMerchantOptions(question.type)) {
      const options = question.options ?? [];
      if (options.length < LIMITS.MIN_OPTIONS) {
        errors.push(
          issue(
            `${base}.options`,
            "options_too_few",
            `Add at least ${LIMITS.MIN_OPTIONS} answer options.`,
          ),
        );
      }
      if (options.length > LIMITS.MAX_OPTIONS) {
        errors.push(
          issue(`${base}.options`, "options_too_many", `Use at most ${LIMITS.MAX_OPTIONS} answer options.`),
        );
      }

      const seen = new Set<string>();
      options.forEach((option, optionIndex) => {
        const optionPath = `${base}.options[${optionIndex}]`;
        if (typeof option.label !== "string" || option.label.trim().length === 0) {
          errors.push(issue(`${optionPath}.label`, "label_required", "Give every option a label, or delete it."));
        } else {
          const e = textTooLong(option.label, LIMITS.MAX_OPTION_LABEL, `${optionPath}.label`, "label_too_long");
          if (e) errors.push(e);
        }
        if (seen.has(option.id)) {
          errors.push(issue(`${optionPath}.id`, "duplicate_option", "Two answer options are the same."));
        }
        seen.add(option.id);
      });

      if (question.type === "multi_choice") {
        const count = options.length;
        const min = question.minSelections ?? null;
        const max = question.maxSelections ?? null;
        if (min !== null && (!Number.isInteger(min) || min < 1)) {
          errors.push(issue(`${base}.minSelections`, "min_invalid", "The minimum must be 1 or more."));
        }
        if (max !== null && (!Number.isInteger(max) || max < 1)) {
          errors.push(issue(`${base}.maxSelections`, "max_invalid", "The maximum must be 1 or more."));
        }
        if (max !== null && max > count) {
          errors.push(
            issue(`${base}.maxSelections`, "max_exceeds_options", "The maximum cannot be more than the number of options."),
          );
        }
        if (min !== null && max !== null && min > max) {
          errors.push(issue(`${base}.minSelections`, "min_above_max", "The minimum cannot be more than the maximum."));
        }
      }
    }

    // Show-if must reference an EARLIER question. That also rules out cycles.
    const cond = question.showIf;
    if (cond) {
      const earlier = questions.slice(0, index).find((q) => q.id === cond.questionId);
      if (!earlier) {
        errors.push(
          issue(`${base}.showIf`, "show_if_unknown", "Show-if must refer to a question that comes before this one."),
        );
      } else if (cond.optionIds && cond.optionIds.length > 0) {
        const allowed = showIfOptionIds(earlier);
        for (const id of cond.optionIds) {
          if (!allowed.has(id)) {
            errors.push(issue(`${base}.showIf`, "show_if_option_unknown", "A show-if answer option no longer exists."));
            break;
          }
        }
      } else if (typeof cond.min === "number" || typeof cond.max === "number") {
        if (!isNumericType(earlier.type)) {
          errors.push(
            issue(`${base}.showIf`, "show_if_not_numeric", "A score range can only refer to a rating or NPS question."),
          );
        }
      } else {
        errors.push(issue(`${base}.showIf`, "show_if_empty", "Choose what this question should depend on."));
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Response validation (buyer input)
// ---------------------------------------------------------------------------

function hasContent(answer: AnswerInput): boolean {
  return (
    (answer.optionIds?.length ?? 0) > 0 ||
    (typeof answer.numberValue === "number" && Number.isFinite(answer.numberValue)) ||
    (typeof answer.textValue === "string" && answer.textValue.trim().length > 0) ||
    (typeof answer.otherText === "string" && answer.otherText.trim().length > 0)
  );
}

/**
 * Validate the buyer's answers against the survey.
 *
 * Uses the same rules as `validateSurveyDefinition` for limits, and additionally
 * checks: required visible questions are answered, hidden questions carry no
 * answer, chosen option ids exist, text is within the character limit, and
 * multiple-choice selection counts respect min/max.
 */
export function validateResponse(
  survey: SurveyDefinition,
  answers: readonly AnswerInput[],
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const known = new Set(survey.questions.map((q) => q.id));

  for (const answer of answers) {
    if (!known.has(answer.questionId)) {
      errors.push(issue(`answers[${answer.questionId}]`, "unknown_question", "That question is not part of this survey."));
    }
  }

  const answersSoFar: AnswerInput[] = [];

  survey.questions.forEach((question, index) => {
    const base = `questions[${index}]`;
    const answer = byId.get(question.id);
    const visible = isQuestionVisible(question, answersSoFar);

    if (!visible) {
      if (answer && hasContent(answer)) {
        errors.push(issue(base, "hidden_answered", "This question is hidden and must not be answered."));
      }
      return;
    }

    const required = question.required === true;

    if (!answer || !hasContent(answer)) {
      if (required) {
        errors.push(
          issue(
            base,
            "required",
            question.type === "text" ? MESSAGES.required_text : MESSAGES.required_choice,
          ),
        );
      }
      if (answer) answersSoFar.push(answer);
      return;
    }

    // Archived options stay valid answers: a buyer who loaded the survey before
    // the merchant removed an option must not lose the answer (results show it
    // as "(removed)"). Shoppers loading the survey now never see it.
    const options = resolveOptions(question, { includeArchived: true });
    const optionById = new Map(options.map((o) => [o.id, o]));

    switch (question.type) {
      case "single_choice":
      case "dropdown": {
        const chosen = answer.optionIds ?? [];
        if (chosen.length !== 1) {
          errors.push(issue(base, "single_required", MESSAGES.required_choice));
          break;
        }
        const id = chosen[0] as string;
        const option = optionById.get(id);
        if (!option) {
          errors.push(issue(base, "unknown_option", "That answer is not one of the available options."));
          break;
        }
        if (option.isOther) {
          const text = answer.otherText?.trim() ?? "";
          if (text.length === 0) errors.push(issue(`${base}.otherText`, "other_required", MESSAGES.other_required));
          else if (text.length > LIMITS.MAX_TEXT_ANSWER) {
            errors.push(issue(`${base}.otherText`, "text_too_long", MESSAGES.text_too_long));
          }
        }
        break;
      }

      case "multi_choice": {
        const chosen = answer.optionIds ?? [];
        const unique = [...new Set(chosen)];
        for (const id of unique) {
          if (!optionById.has(id)) {
            errors.push(issue(base, "unknown_option", "That answer is not one of the available options."));
            break;
          }
        }
        // T6: an exclusive option must not be combined with any other.
        const exclusiveChosen = unique.filter((id) => optionById.get(id)?.exclusive);
        if (exclusiveChosen.length > 0 && unique.length > 1) {
          errors.push(
            issue(base, "exclusive_with_others", "That answer clears the others. Choose it on its own."),
          );
        }
        const min = question.minSelections ?? null;
        const max = question.maxSelections ?? null;
        if (min !== null && unique.length < min) {
          errors.push(issue(base, "min_selections", MESSAGES.min_selections(min)));
        }
        if (max !== null && unique.length > max) {
          errors.push(issue(base, "max_selections", MESSAGES.max_selections(max)));
        }
        if (unique.some((id) => optionById.get(id)?.isOther)) {
          const text = answer.otherText?.trim() ?? "";
          if (text.length === 0) errors.push(issue(`${base}.otherText`, "other_required", MESSAGES.other_required));
          else if (text.length > LIMITS.MAX_TEXT_ANSWER) {
            errors.push(issue(`${base}.otherText`, "text_too_long", MESSAGES.text_too_long));
          }
        }
        break;
      }

      case "yes_no": {
        const value = answer.numberValue;
        if (value !== 0 && value !== 1) {
          errors.push(issue(base, "yes_no_invalid", MESSAGES.required_choice));
        }
        break;
      }

      case "satisfaction_5": {
        const chosen = answer.optionIds ?? [];
        if (chosen.length !== 1 || satisfactionValue(chosen[0] as string) === undefined) {
          errors.push(issue(base, "satisfaction_invalid", MESSAGES.required_choice));
        }
        break;
      }

      case "rating_5": {
        const value = answer.numberValue;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
          errors.push(issue(base, "rating_invalid", MESSAGES.required_choice));
        }
        break;
      }

      case "nps": {
        const value = answer.numberValue;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) {
          errors.push(issue(base, "nps_invalid", MESSAGES.required_choice));
        }
        break;
      }

      case "text": {
        const text = answer.textValue?.trim() ?? "";
        if (text.length === 0 && required) {
          errors.push(issue(base, "required", MESSAGES.required_text));
        } else if (text.length > LIMITS.MAX_TEXT_ANSWER) {
          errors.push(issue(base, "text_too_long", MESSAGES.text_too_long));
        }
        break;
      }
    }

    answersSoFar.push(answer);
  });

  return errors;
}

/**
 * Reduce a buyer's raw answer set to what is stored, before `validateResponse`.
 *
 * - A question id answered twice is refused (`duplicate_answer`): validation
 *   only ever saw the last entry, while every entry used to be stored.
 * - Archived questions are removed from the definition: buyers never see them,
 *   so a `required` flag left on one must not block every submission.
 * - Answers to questions that are hidden by show-if (evaluated in order, using
 *   only answers to visible questions, exactly like `validateResponse`) are
 *   dropped rather than rejected, so a buyer who changed an earlier answer does
 *   not lose the whole set.
 * - With `stale` (the buyer answered an older published version), answers to
 *   questions that no longer exist are dropped, and the caller relaxes
 *   `required` for questions the buyer could not have seen.
 * - Each kept answer carries only the fields its question type uses.
 *   `satisfaction_5` gets its canonical 1–5 `numberValue` from the option id,
 *   and yes/no keeps `optionIds` only as the `["yes"]`/`["no"]` mirror.
 */
export function normalizeResponseAnswers(
  survey: SurveyDefinition,
  answers: readonly AnswerInput[],
  { stale = false }: { stale?: boolean } = {},
): { definition: SurveyDefinition; answers: AnswerInput[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    if (seen.has(answer.questionId)) {
      issues.push(issue(`answers[${answer.questionId}]`, "duplicate_answer", "A question was answered twice."));
    }
    seen.add(answer.questionId);
  }

  const active = survey.questions.filter((q) => !q.archived);
  const archivedIds = new Set(survey.questions.filter((q) => q.archived).map((q) => q.id));
  const definition: SurveyDefinition = { ...survey, questions: active };
  const byId = new Map(answers.map((a) => [a.questionId, a]));

  const kept: AnswerInput[] = [];
  const answersSoFar: AnswerInput[] = [];
  for (const question of active) {
    const answer = byId.get(question.id);
    if (!isQuestionVisible(question, answersSoFar)) continue;
    if (!answer) continue;
    const projected = projectAnswer(question, answer);
    kept.push(projected);
    answersSoFar.push(projected);
  }

  // Unknown question ids stay in the set (so `validateResponse` reports them)
  // unless the buyer answered an older version or the question was archived.
  const known = new Set(active.map((q) => q.id));
  for (const answer of answers) {
    if (known.has(answer.questionId) || archivedIds.has(answer.questionId)) continue;
    if (!stale) kept.push(answer);
  }

  return { definition, answers: kept, issues };
}

function projectAnswer(question: SurveyQuestionDef, answer: AnswerInput): AnswerInput {
  const base: AnswerInput = { questionId: question.id };
  switch (question.type) {
    case "single_choice":
    case "dropdown":
    case "multi_choice": {
      const optionIds = answer.optionIds ?? [];
      const options = resolveOptions(question, { includeArchived: true });
      const otherChosen = optionIds.some((id) => options.find((o) => o.id === id)?.isOther);
      return {
        ...base,
        optionIds,
        ...(otherChosen && answer.otherText != null ? { otherText: answer.otherText } : {}),
      };
    }
    case "satisfaction_5": {
      const optionIds = answer.optionIds ?? [];
      const value = optionIds.length === 1 ? satisfactionValue(optionIds[0] as string) : undefined;
      return { ...base, optionIds, numberValue: value ?? null };
    }
    case "yes_no": {
      const mirrored = answer.optionIds?.[0];
      const value =
        answer.numberValue === 1 || answer.numberValue === 0
          ? answer.numberValue
          : mirrored === YES_NO_IDS.yes
            ? 1
            : mirrored === YES_NO_IDS.no
              ? 0
              : answer.numberValue;
      if (value === 1 || value === 0) {
        return { ...base, numberValue: value, optionIds: [value === 1 ? YES_NO_IDS.yes : YES_NO_IDS.no] };
      }
      return { ...base, numberValue: value ?? null };
    }
    case "rating_5":
    case "nps":
      return { ...base, numberValue: answer.numberValue ?? null };
    case "text":
      return { ...base, textValue: answer.textValue ?? null };
  }
}
