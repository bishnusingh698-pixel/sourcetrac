/**
 * What each plan includes, beyond the Free response cap in `app/lib/plans.ts`.
 *
 * One table so the Plans page, the editor's locked sections and the server's
 * enforcement cannot disagree. Dependency-free, like the rest of `shared/`,
 * because the template catalogue reads it too.
 *
 * The split follows what small merchants ask for first (see the 2026-10-15
 * pricing notes in AGENTS.md):
 * - Free keeps the whole attribution use case: the "how did you hear" question,
 *   follow-up questions, new vs returning buyers, revenue by channel, export.
 * - Growth adds volume and reach: unlimited answers, 10 live surveys, the full
 *   version of every template and the detailed "who sees it" rules.
 * - Scale adds automation and removes the live-survey limit: writing answers
 *   back to Shopify (tags, metafields, Flow), stopping a survey once the answer
 *   is clear, and rotating surveys.
 */

export type PlanTier = "free" | "growth" | "scale";

const RANK: Record<PlanTier, number> = { free: 0, growth: 1, scale: 2 };

/** Normalise a stored plan value (unknown -> free). */
export function planTier(plan: unknown): PlanTier {
  return plan === "growth" ? "growth" : plan === "scale" ? "scale" : "free";
}

export function planAtLeast(plan: PlanTier, required: PlanTier): boolean {
  return RANK[plan] >= RANK[required];
}

export type PlanFeature =
  /** The full version of every template (extra questions, "None of these", per-product results). */
  | "full_templates"
  /** Order value, share of orders, countries, languages, dates, answer limit. */
  | "advanced_targeting"
  /** Order tags, customer tags, metafields and the Flow trigger. */
  | "shopify_actions"
  /** Pause a survey automatically once the answer is clear (T10). */
  | "auto_stop"
  /** Rotate several live surveys across orders (T11). */
  | "rotation";

export const FEATURE_PLAN: Record<PlanFeature, PlanTier> = {
  full_templates: "growth",
  advanced_targeting: "growth",
  shopify_actions: "scale",
  auto_stop: "scale",
  rotation: "scale",
};

export function planHas(plan: PlanTier, feature: PlanFeature): boolean {
  return planAtLeast(plan, FEATURE_PLAN[feature]);
}

/**
 * How many surveys may be live at once; null is no limit. A live survey costs
 * nothing to serve (the block fetches only the one it shows), so the limit is
 * there to separate the plans, not to protect the server.
 */
export const LIVE_SURVEY_LIMIT: Record<PlanTier, number | null> = { free: 1, growth: 10, scale: null };

export function liveSurveyLimit(plan: PlanTier): number | null {
  return LIVE_SURVEY_LIMIT[plan];
}

/** The cheapest plan that includes a feature, for "Available on Growth" labels. */
export function requiredPlanFor(feature: PlanFeature): PlanTier {
  return FEATURE_PLAN[feature];
}

/**
 * The targeting fields that need `advanced_targeting`. "Who sees it" by
 * customer type (everyone, first order, returning) stays free: it is the
 * setting merchants most often need, and many template questions only make
 * sense for one of the two groups.
 */
export type AdvancedTargetingFields = {
  minValue?: number | null;
  maxValue?: number | null;
  productIds?: string[];
  collectionIds?: string[];
  countries?: string[];
  languages?: string[];
  samplePercent?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  maxResponses?: number | null;
};

/**
 * The advanced part of a targeting object in a canonical form: empty values
 * dropped, lists sorted, so two settings that behave the same compare equal.
 */
export function advancedTargetingKey(targeting: AdvancedTargetingFields | null | undefined): string {
  const t = targeting ?? {};
  const list = (value: unknown) =>
    Array.isArray(value) ? [...value].filter((v) => typeof v === "string" && v.length > 0).sort() : [];
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const canonical = {
    minValue: num(t.minValue),
    maxValue: num(t.maxValue),
    productIds: list(t.productIds),
    collectionIds: list(t.collectionIds),
    countries: list(t.countries),
    languages: list(t.languages),
    // 100% is the same as not sampling at all.
    samplePercent: num(t.samplePercent) === 100 ? null : num(t.samplePercent),
    startsAt: typeof t.startsAt === "string" && t.startsAt ? t.startsAt : null,
    endsAt: typeof t.endsAt === "string" && t.endsAt ? t.endsAt : null,
    maxResponses: num(t.maxResponses),
  };
  return JSON.stringify(canonical);
}

const NO_ADVANCED_TARGETING = advancedTargetingKey({});

/** Whether a targeting object uses any Growth-only rule. */
export function usesAdvancedTargeting(targeting: AdvancedTargetingFields | null | undefined): boolean {
  return advancedTargetingKey(targeting) !== NO_ADVANCED_TARGETING;
}

/** Whether sync options ask for any Shopify write. */
export function usesShopifyActions(syncOptions: unknown): boolean {
  if (!syncOptions || typeof syncOptions !== "object") return false;
  const o = syncOptions as Record<string, unknown>;
  const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
  return nonEmpty(o.orderTags) || nonEmpty(o.customerTags) || nonEmpty(o.metafields) || nonEmpty(o.presets) || o.flowTrigger === true;
}
