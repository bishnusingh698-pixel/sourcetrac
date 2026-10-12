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
};

export type CompiledOption = {
  id: string;
  label: string;
  isOther: boolean;
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

/**
 * Whether a survey's targeting matches an order. Every set field must hold; an
 * unset field is ignored. This runs on the server (config compile/select) and in
 * the extension is unnecessary — the server only sends surveys that match.
 *
 * The order-value rule is skipped when `valueCurrency` differs from the order's
 * currency, so a multi-currency store never hides a survey for a reason the
 * merchant cannot see.
 */
export function matchesTargeting(
  targeting: Targeting | undefined,
  facts: {
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
  },
): boolean {
  if (!targeting) return true;

  if (targeting.startsAt && facts.now < new Date(targeting.startsAt)) return false;
  if (targeting.endsAt && facts.now >= new Date(targeting.endsAt)) return false;
  if (targeting.maxResponses != null && facts.responseCount >= targeting.maxResponses) return false;

  if (targeting.samplePercent != null && targeting.samplePercent < 100) {
    if (!facts.orderId) return false;
    // Deterministic per order, so the two surfaces agree.
    let h = 2166136261 >>> 0;
    for (let i = 0; i < facts.orderId.length; i += 1) {
      h ^= facts.orderId.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    if ((h >>> 0) % 100 >= targeting.samplePercent) return false;
  }

  if (targeting.customerType === "first_order" && facts.isFirstOrder !== true) return false;
  if (targeting.customerType === "returning" && facts.isFirstOrder !== false) return false;

  if (targeting.countries && targeting.countries.length > 0) {
    if (!facts.country || !targeting.countries.includes(facts.country)) return false;
  }

  if (targeting.languages && targeting.languages.length > 0) {
    if (!facts.language || !targeting.languages.includes(facts.language)) return false;
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
    if (targeting.minValue != null && facts.orderTotalMinor < Math.round(targeting.minValue * factor)) return false;
    if (targeting.maxValue != null && facts.orderTotalMinor > Math.round(targeting.maxValue * factor)) return false;
  }

  return true;
}

export type { SurveyOptionDef };
