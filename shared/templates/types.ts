/**
 * Template data format.
 *
 * Templates live in CODE, not the database: zero Neon cost, versioned with the
 * app, and unit-testable. A survey created from a template is an independent
 * copy — later template changes never modify existing surveys.
 *
 * Dependency-free, like the other `shared/` modules, because it is also read by
 * the checkout extension build.
 */

import type { DesignSettings, QuestionType } from "../survey-rules";

export type TemplateCategory =
  | "marketing"
  | "product_page"
  | "delivery"
  | "loyalty"
  | "know_customer"
  | "after_delivery";

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  "marketing",
  "product_page",
  "delivery",
  "loyalty",
  "know_customer",
  "after_delivery",
];

/** Answer-pack families, defined in `packs.ts`. */
export type PackFamily =
  | "channels"
  | "occasions"
  | "profiles_beauty"
  | "profiles_fashion"
  | "profiles_food"
  | "profiles_pets"
  | "profiles_home";

export interface TemplateOption {
  /** Stable key inside the template, e.g. "instagram". */
  key: string;
  /** i18n key; text lives in `shared/templates/locales/<locale>.json`. */
  labelKey: string;
  /** "Other (please specify)". */
  isOther?: boolean;
  /** T6: clears other selections in multiple choice. */
  exclusive?: boolean;
}

export interface TemplateQuestion {
  /** Stable key, e.g. "q_channel". */
  key: string;
  type: QuestionType;
  textKey: string;
  helpTextKey?: string;
  placeholderKey?: string;
  required: boolean;
  /** Shows as a toggle in Quick setup step 1. */
  optionalInSetup?: boolean;
  /** A fixed list, or an answer-pack family. */
  options?: TemplateOption[];
  pack?: PackFamily;
  randomize?: boolean;
  maxSelections?: number;
  multiline?: boolean;
  /** S12 defaults for rating/NPS questions. */
  scaleLabelKeys?: { low: string; high: string };
  showIf?: { questionKey: string; optionKeys?: string[]; min?: number; max?: number };
}

export interface TemplateDefaults {
  audience: "everyone" | "first_order" | "returning";
  placements: Array<"thank_you" | "order_status" | "survey_link">;
  samplePercent: number;
  /** T7: only orders paid with a manual payment method. */
  paymentManualOnly?: boolean;
  /** Quick setup step 2 pre-opens product targeting (Fit Confidence, Reorder Clock). */
  productsOnly?: boolean;
  /** T10. */
  learnAndStop?: boolean;
  /** S11 design overrides. */
  design?: Partial<DesignSettings>;
}

export interface TemplateDefinition {
  /** Stable, kebab-case, never renamed. */
  id: string;
  version: number;
  nameKey: string;
  oneLinerKey: string;
  category: TemplateCategory;
  /** 1–3, from `tags.ts`. */
  outcomeTags: string[];
  /** "What you'll learn" bullets (2–3). */
  learnKeys: string[];
  /** 1–5. */
  questions: TemplateQuestion[];
  /** T5: the subset that fits the Free plan. */
  liteQuestionKeys: string[];
  defaults: TemplateDefaults;
  /** ISO country codes for "Popular in your region"; empty = everywhere. */
  popularIn?: string[];
  /** T15, from `seasons.ts`. */
  seasons?: string[];
  /** T13 presets, from `smart-actions.ts`. */
  smartActions?: string[];
  /** T12 rule ids, from `ideas.ts`. */
  ideas: string[];
  resultsHints?: { crossQuestion?: [string, string]; byProduct?: boolean };
  goodToKnowKeys?: string[];
  /** The legacy template id this replaces, if any. */
  classicOf?: string;
  /**
   * Extra words the library search matches, for the jargon merchants type
   * ("NPS", "attribution", "CSAT"). Not shown; English is fine, the terms are
   * the same in every language.
   */
  searchAliases?: string[];
}
