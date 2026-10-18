/**
 * Compiled survey config — the exact shape the checkout extension reads.
 *
 * The server compiles active surveys into this shape on save, and the extension
 * makes every show/hide decision from it, so no shopper page view touches the
 * database. It is deliberately compact (LIMITS.MAX_COMPILED_CONFIG_BYTES) and
 * dependency-free, like survey-rules.ts.
 */

import type { QuestionType, ShowIf, SurveyOptionDef } from "./survey-rules";

/** Where a survey can appear. */
export const PLACEMENTS = ["thank_you", "order_status", "onsite", "link"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type CustomerType = "everyone" | "first_order" | "returning";

/**
 * Who sees the survey. Every set field must match. An unset field is ignored.
 *
 * The order-value rule is skipped when the shopper's currency differs from
 * `valueCurrency`, so a multi-currency store never hides a survey for a reason
 * the merchant cannot see.
 */
export type Targeting = {
  customerType?: CustomerType;
  minValue?: number | null;
  maxValue?: number | null;
  valueCurrency?: string | null;
  productIds?: string[];
  collectionIds?: string[];
  /** Collection ids resolved to product ids on save (needs read_products). */
  resolvedProductIds?: string[];
  countries?: string[];
  languages?: string[];
  /** 1–100. Deterministic per order id. */
  samplePercent?: number;
  /** ISO-8601 instants. */
  startsAt?: string | null;
  endsAt?: string | null;
  /** Pause automatically once this many responses are collected. */
  maxResponses?: number | null;
  /**
   * T7: show only on Thank-you for orders paid with a manual payment method
   * (e.g. Cash on Delivery). Compiled into the config's `paymentManualOnly`.
   */
  paymentManualOnly?: boolean;
};

export type CompiledOption = {
  id: string;
  label: string;
  isOther: boolean;
  /** T6: selecting it clears other selections in multiple choice. */
  exclusive?: boolean;
  /** locale -> translated label. */
  translations?: Record<string, string | undefined>;
};

export type CompiledQuestion = {
  id: string;
  type: QuestionType;
  text: string;
  helpText?: string | null;
  placeholder?: string | null;
  textMultiline: boolean;
  required: boolean;
  randomizeOptions: boolean;
  allowOther: boolean;
  minSelections?: number | null;
  maxSelections?: number | null;
  showIf?: ShowIf | null;
  options: CompiledOption[];
  /** locale -> { text, helpText, placeholder }. */
  translations?: Record<string, { text?: string; helpText?: string; placeholder?: string } | undefined>;
};

export type CompiledText = {
  title?: string;
  intro?: string;
  buttonLabel?: string;
  thankYouText?: string;
  questions?: Record<string, { text?: string; helpText?: string; placeholder?: string } | undefined>;
  options?: Record<string, string | undefined>;
};

export type CompiledSurvey = {
  id: string;
  version: number;
  priority: number;
  placements: Placement[];
  layout: "all" | "one_by_one";
  title: string;
  intro: string | null;
  buttonLabel: string;
  thankYouText: string;
  channelReportQuestionId: string | null;
  targeting: Targeting;
  questions: CompiledQuestion[];
  /** locale -> translated text. */
  translations?: Record<string, CompiledText | undefined>;
  /** S11/S12 design settings; compiled so the extension needs no source. */
  design?: CompiledDesign;
  /** T11: this survey shares its placements with other rotation members. */
  rotation?: boolean;
  /** T11: 1 (low) / 2 (normal) / 3 (high). */
  rotationWeight?: number;
  /**
   * How many answers this survey has collected. Carried so the server can
   * enforce `targeting.maxResponses`; without it the route had no count and the
   * "pause after N responses" rule silently never fired.
   */
  responseCount: number;
  /** T7: show only on orders paid with a manual payment method. */
  paymentManualOnly?: boolean;
};

/** Design settings as the extension reads them. Mirrors DesignSettings. */
export type CompiledDesign = {
  layout: "all" | "one_by_one";
  showProgress: boolean;
  showTitle: boolean;
  ratingStyle: "numbers" | "stars";
  scaleLowLabel: string;
  scaleHighLabel: string;
  cardBorder: "border" | "no_border";
  spacing: "compact" | "comfortable";
};

export type CompiledConfig = {
  version: number;
  /** Highest priority first. */
  surveys: CompiledSurvey[];
};

/** Defaults from Appendix B. */
export const DEFAULT_SURVEY_TEXT = {
  title: "Quick question",
  intro: "Your answer helps us improve. It takes 10 seconds.",
  buttonLabel: "Submit",
  thankYouText: "Thanks for your feedback!",
} as const;

/** Options the extension renders for a question, in display order handled there. */
export function optionsForQuestion(question: CompiledQuestion): CompiledOption[] {
  return question.options;
}

/** Narrow an option list for the answer UI, tolerating a missing array. */
export function safeOptions(option: CompiledOption[] | undefined): CompiledOption[] {
  return Array.isArray(option) ? option : [];
}

/** The order facts a survey's targeting is judged on. */
export type TargetingFacts = {
  orderId: string | null;
  orderTotalMinor: number | null;
  currency: string | null;
  /** Minor-unit digits for `currency` (JPY 0, USD 2, KWD 3). */
  currencyDigits: number;
  isFirstOrder: boolean | null;
  country: string | null;
  language: string | null;
  now: Date;
  responseCount: number;
};

/**
 * Why a survey's targeting keeps it from an order, the first rule that fails.
 * Shown to the merchant on the Surveys page ("Recent checkouts"), so each one
 * must be something they can act on. `_unknown` means the checkout did not tell
 * us the fact the rule needs, which is different from the fact not matching.
 */
export type TargetingMiss =
  | "not_started"
  | "ended"
  | "max_responses"
  | "sample"
  | "first_order_only"
  | "returning_only"
  | "customer_type_unknown"
  | "country"
  | "country_unknown"
  | "language"
  | "order_value";

/**
 * A date rule as an instant. Rules saved by the editor are ISO instants already
 * computed in the shop's time zone (see `shared/zoned-date.ts`). Older rules
 * were a bare `YYYY-MM-DD`, which `new Date()` reads as UTC midnight: the
 * start keeps that meaning, and an end date is read as the END of that day, as
 * the merchant who picked it meant (it used to stop a day early).
 */
export function targetingInstant(value: string | null | undefined, edge: "start" | "end"): Date | null {
  if (!value) return null;
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(bare ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return null;
  if (bare && edge === "end") date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/** Whether a buyer's language tag ("en-US", "pt-BR") is in a list ("en", "pt-BR"). */
export function languageMatches(language: string, wanted: readonly string[]): boolean {
  const tag = language.toLowerCase();
  const base = tag.split("-")[0];
  return wanted.some((code) => {
    const want = code.toLowerCase();
    return want === tag || want === base || want.split("-")[0] === tag;
  });
}

/**
 * The first targeting rule that keeps this survey from the order, or null when
 * every set rule holds. An unset field is ignored. This is the only place the
 * rules are decided; `matchesTargeting` and the merchant's diagnostics both
 * read it, so they cannot disagree.
 *
 * The order-value rule is skipped when `valueCurrency` differs from the order's
 * currency, or the total is not known yet, so a multi-currency store never hides
 * a survey for a reason the merchant cannot see.
 */
export function explainTargeting(targeting: Targeting | undefined, facts: TargetingFacts): TargetingMiss | null {
  if (!targeting) return null;

  const startsAt = targetingInstant(targeting.startsAt, "start");
  const endsAt = targetingInstant(targeting.endsAt, "end");
  if (startsAt && facts.now < startsAt) return "not_started";
  if (endsAt && facts.now >= endsAt) return "ended";
  if (targeting.maxResponses != null && facts.responseCount >= targeting.maxResponses) return "max_responses";

  if (targeting.samplePercent != null && targeting.samplePercent < 100) {
    if (!facts.orderId) return "sample";
    // Deterministic per order, so the two surfaces agree.
    let h = 2166136261 >>> 0;
    for (let i = 0; i < facts.orderId.length; i += 1) {
      h ^= facts.orderId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    if ((h >>> 0) % 100 >= targeting.samplePercent) return "sample";
  }

  if (targeting.customerType === "first_order" || targeting.customerType === "returning") {
    if (facts.isFirstOrder === null) return "customer_type_unknown";
    if (targeting.customerType === "first_order" && !facts.isFirstOrder) return "first_order_only";
    if (targeting.customerType === "returning" && facts.isFirstOrder) return "returning_only";
  }

  if (targeting.countries && targeting.countries.length > 0) {
    if (!facts.country) return "country_unknown";
    if (!targeting.countries.includes(facts.country.toUpperCase())) return "country";
  }

  if (targeting.languages && targeting.languages.length > 0) {
    if (!facts.language || !languageMatches(facts.language, targeting.languages)) return "language";
  }

  if (
    (targeting.minValue != null || targeting.maxValue != null) &&
    targeting.valueCurrency &&
    facts.currency === targeting.valueCurrency &&
    facts.orderTotalMinor != null
  ) {
    // Convert the merchant's major-unit bounds with the currency's own
    // precision, never a hardcoded 2: JPY has 0 digits and KWD has 3.
    const factor = 10 ** facts.currencyDigits;
    if (targeting.minValue != null && facts.orderTotalMinor < Math.round(targeting.minValue * factor)) return "order_value";
    if (targeting.maxValue != null && facts.orderTotalMinor > Math.round(targeting.maxValue * factor)) return "order_value";
  }

  return null;
}

/** Whether a survey's targeting matches an order. See `explainTargeting`. */
export function matchesTargeting(targeting: Targeting | undefined, facts: TargetingFacts): boolean {
  return explainTargeting(targeting, facts) === null;
}

/**
 * Whether any rule can keep a buyer from seeing the survey, so the checkout
 * editor can say that some orders will not see it. The same fields
 * `matchesTargeting` and `matchesPaymentRule` read.
 */
export function hasAudienceRules(targeting: Targeting | undefined, paymentManualOnly = false): boolean {
  if (paymentManualOnly) return true;
  if (!targeting) return false;
  return Boolean(
    targeting.startsAt ||
      targeting.endsAt ||
      targeting.maxResponses != null ||
      (targeting.samplePercent != null && targeting.samplePercent < 100) ||
      targeting.customerType === "first_order" ||
      targeting.customerType === "returning" ||
      (targeting.countries?.length ?? 0) > 0 ||
      (targeting.languages?.length ?? 0) > 0 ||
      ((targeting.minValue != null || targeting.maxValue != null) && targeting.valueCurrency),
  );
}

export type { SurveyOptionDef };

// ---------------------------------------------------------------------------
// Selection: rotation (T11) and payment-method targeting (T7)
// ---------------------------------------------------------------------------

/**
 * The rotation group within `surveys` that share a placement: every active,
 * rotation-enabled survey whose targeting matches. The server picks one member.
 */
export function rotationGroup(
  surveys: readonly CompiledSurvey[],
  placement: Placement,
  matches: (survey: CompiledSurvey) => boolean,
): CompiledSurvey[] {
  return surveys.filter((s) => s.rotation === true && s.placements.includes(placement) && matches(s));
}

/** A deterministic 0..1 value from an order id, for weighted rotation picks. */
function seededUnit(orderId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < orderId.length; i += 1) {
    h ^= orderId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Pick one survey from a rotation group, weighted and deterministic by order id.
 *
 * The same order id always yields the same member, so the Thank-you and
 * Order-status pages agree. An order id is required: rotating for an id-less
 * surface would be unstable, so the first member is returned instead.
 */
export function pickFromRotation(group: readonly CompiledSurvey[], orderId: string | null): CompiledSurvey | null {
  if (group.length === 0) return null;
  if (group.length === 1) return group[0]!;
  if (!orderId) return group[0]!;

  const weights = group.map((s) => (typeof s.rotationWeight === "number" && s.rotationWeight > 0 ? s.rotationWeight : 2));
  const total = weights.reduce((sum, w) => sum + w, 0);
  let target = seededUnit(orderId) * total;

  for (let i = 0; i < group.length; i += 1) {
    target -= weights[i]!;
    if (target <= 0) return group[i]!;
  }
  return group[group.length - 1]!;
}

/**
 * Whether the survey should be shown, given the shopper's payment methods (T7).
 *
 * Only applies when `paymentManualOnly` is set. The checkout extension reads
 * `shopify.selectedPaymentOptions` and passes the option type strings. An empty
 * list is treated as NOT matched, because the field has been observed empty on
 * Thank-you for some offsite methods, and hiding is the safe failure.
 *
 * Verified against the installed `@shopify/ui-extensions` types (2026-07): the
 * `type` union is `creditCard | deferred | local | manualPayment | offsite |
 * other | paymentOnDelivery | redeemable | wallet | customOnsite`. A manual
 * payment method ("Cash on Delivery", bank transfer) is `manualPayment`, and a
 * payment collected on delivery is `paymentOnDelivery` — a COD shop can be
 * either, so both must match.
 */
export function matchesPaymentRule(
  survey: CompiledSurvey,
  paymentTypes: readonly string[],
  placement: Placement,
): boolean {
  if (!survey.paymentManualOnly) return true;
  // Payment targeting is a Thank-you-page concept only (T7).
  if (placement !== "thank_you") return false;
  return paymentTypes.some((type) => type === "manualPayment" || type === "paymentOnDelivery");
}
