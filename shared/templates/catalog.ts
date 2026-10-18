/**
 * Template catalogue view-model (T1 gallery, T2 detail).
 *
 * Pure functions that turn the code-defined templates into exactly what the
 * gallery and detail pages render, in the merchant's language and region, gated
 * by their plan. Keeping this out of the route means the search/filter logic, the
 * plan gating and the season banner are unit-testable with no React and no
 * database.
 *
 * Dependency-free, like the rest of `shared/templates`.
 */

import { LIMITS } from "../survey-rules";
import { activeSeason, type Season, type SeasonId } from "./seasons";
import { templateById, TEMPLATES } from "./index";
import { templateText } from "./locales";
import { packFor, regionPackFor, type Pack, type RegionPack } from "./packs";
import { isTagId, type TagId } from "./tags";
import type { PackFamily, TemplateCategory, TemplateDefinition, TemplateQuestion } from "./types";

/** Plan tiers, weakest to strongest. Mirrors `app/lib/plans.ts`. */
export type CatalogPlan = "free" | "growth" | "scale";

const PLAN_RANK: Record<CatalogPlan, number> = { free: 0, growth: 1, scale: 2 };

function planAtLeast(plan: CatalogPlan, required: CatalogPlan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[required];
}

/** Normalise a stored plan value into a `CatalogPlan` (unknown -> free). */
export function catalogPlanFromKey(plan: unknown): CatalogPlan {
  return plan === "growth" ? "growth" : plan === "scale" ? "scale" : "free";
}

/** Whether a plan includes the paid (Growth and above) feature set. */
export function planIncludesGrowth(plan: CatalogPlan): boolean {
  return planAtLeast(plan, "growth");
}

/**
 * Whether the template's FULL version is out of reach for a plan.
 *
 * The server create paths must use this (with the effective plan) so a crafted
 * request cannot create a Growth template — an exclusive option (T6) or a
 * by-product breakdown (T8) — on the Free plan. The gallery only hides the
 * button; that is a suggestion, not enforcement.
 */
export function templateLockedForPlan(template: TemplateDefinition, plan: CatalogPlan): boolean {
  return !planAtLeast(plan, templateRequiredPlan(template));
}

/**
 * Whether the definition's own content uses a Growth-only feature.
 *
 * Content-based so the Lite version (which turns the exclusive option into an
 * ordinary one) passes
 * on Free while the full version does not. The by-product breakdown is not a
 * question-level feature, so it is checked separately by template id.
 */
export function definitionHasExclusiveOption(definition: {
  questions: ReadonlyArray<{ options?: ReadonlyArray<{ exclusive?: boolean }> }>;
}): boolean {
  return definition.questions.some((q) => (q.options ?? []).some((o) => o.exclusive === true));
}

/**
 * Whether a template actually has a Free version.
 *
 * A Lite subset exists AND the template has no by-product breakdown, which
 * cannot be subset away (it is a results feature tied to the template id). An
 * exclusive option does not block Free: the Lite build makes it ordinary.
 */
export function templateHasFreeVersion(template: TemplateDefinition): boolean {
  if (template.liteQuestionKeys.length === 0) return false;
  if (template.liteQuestionKeys.length > LIMITS.RECOMMENDED_MAX_QUESTIONS) return false;
  if (template.resultsHints?.byProduct) return false;
  return true;
}

/**
 * The plan a template's FULL version needs.
 *
 * Growth includes the full version of every template (`full_templates` in
 * `shared/plan-features.ts`): one with questions beyond its Free version, an
 * exclusive option (T6) or a by-product breakdown (T8). A template whose Free
 * version is the whole template is free. Smart actions (T13) are opt-in
 * settings inside a survey, not a property of the template, so they do not gate
 * it; the editor offers them on Scale.
 */
export function templateRequiredPlan(template: TemplateDefinition): CatalogPlan {
  const hasExclusive = template.questions.some((q) => q.options?.some((o) => o.exclusive));
  if (hasExclusive) return "growth";
  if (template.resultsHints?.byProduct) return "growth";
  const lite = new Set(template.liteQuestionKeys);
  if (lite.size > 0 && template.questions.some((q) => !lite.has(q.key))) return "growth";
  return "free";
}

/** The category tab order; After delivery is hidden unless its flag is on. */
export const CATEGORY_ORDER: readonly TemplateCategory[] = [
  "marketing",
  "product_page",
  "delivery",
  "loyalty",
  "know_customer",
  "after_delivery",
];

export type CatalogTag = { id: TagId; text: string; tip: string };

export type CatalogCard = {
  id: string;
  name: string;
  oneLiner: string;
  category: TemplateCategory;
  /** At most 3; the card shows 2 + "+N". */
  tags: CatalogTag[];
  /** Extra tags beyond the first 2, for the "+N" indicator. */
  extraTagCount: number;
  questionCount: number;
  /** Rough reading time, in seconds. */
  seconds: number;
  /** True when the full version is not available on the current plan. */
  planLocked: boolean;
  /** The plan the full version needs, when locked. */
  requiredPlan: CatalogPlan;
  /** Whether a Lite version exists and fits the Free plan. */
  hasLite: boolean;
  /** ISO country codes for "Popular in your region"; empty = everywhere. */
  popularIn: readonly string[];
  /** True when the template is marketed on the Thank you page. */
  thankYou: boolean;
  /** True when the template is marketed on the survey link page. */
  surveyLink: boolean;
  /** 1–2 questions on the full version. */
  isShort: boolean;
  seasons: readonly SeasonId[];
};

export type CatalogOptions = {
  locale: string;
  plan: CatalogPlan;
  /** The shop's ISO country code, for the region pack and "popular here". */
  country: string | null;
  /** Whether the survey-link bonus placement is enabled. */
  surveyLinkEnabled: boolean;
};

function tagText(locale: string, id: TagId): CatalogTag {
  return {
    id,
    text: templateText(locale, `tags.${id}`),
    tip: templateText(locale, `tags.${id}.tip`),
  };
}

/** Seconds per question, used for the "about N seconds" meta line. */
const SECONDS_PER_QUESTION = 8;

export function catalogCards(options: CatalogOptions): CatalogCard[] {
  const { locale, plan, country, surveyLinkEnabled } = options;
  return TEMPLATES.filter((t) => t.category !== "after_delivery" || surveyLinkEnabled).map((t) => {
    const tagIds = t.outcomeTags.filter(isTagId);
    const tags = tagIds.slice(0, 3).map((id) => tagText(locale, id));
    const requiredPlan = templateRequiredPlan(t);
    return {
      id: t.id,
      name: templateText(locale, t.nameKey),
      oneLiner: templateText(locale, t.oneLinerKey),
      category: t.category,
      tags,
      extraTagCount: Math.max(0, tags.length - 2),
      questionCount: t.questions.length,
      seconds: t.questions.length * SECONDS_PER_QUESTION,
      planLocked: !planAtLeast(plan, requiredPlan),
      requiredPlan,
      hasLite: templateHasFreeVersion(t),
      popularIn: t.popularIn ?? [],
      thankYou: t.defaults.placements.includes("thank_you"),
      surveyLink: t.defaults.placements.includes("survey_link"),
      isShort: t.questions.length <= 2,
      seasons: (t.seasons ?? []) as SeasonId[],
    };
  });
}

/**
 * Whether a template counts as "popular in" the shop's region.
 *
 * An empty `popularIn` means the template is useful everywhere (the spec's
 * convention), so it matches every country. A listed set matches only those
 * ISO codes.
 */
export function isPopularHere(card: CatalogCard, country: string): boolean {
  return card.popularIn.length === 0 || card.popularIn.includes(country);
}

/**
 * Filter cards for the gallery.
 *
 * `q` matches name, one-liner and tag text in the admin language, so a search
 * for a market word finds the template even when its name does not contain it.
 */
export function filterCards(
  cards: readonly CatalogCard[],
  filters: {
    q?: string;
    category?: TemplateCategory | "all";
    shortOnly?: boolean;
    freeOnly?: boolean;
    popularHere?: boolean;
    country?: string | null;
    thankYou?: boolean;
    surveyLink?: boolean;
  },
): CatalogCard[] {
  const q = filters.q?.trim().toLowerCase();
  return cards.filter((card) => {
    if (filters.category && filters.category !== "all" && card.category !== filters.category) return false;
    if (filters.shortOnly && !card.isShort) return false;
    if (filters.freeOnly && (card.planLocked || !card.hasLite)) return false;
    if (filters.popularHere && !(filters.country && isPopularHere(card, filters.country))) return false;
    if (filters.thankYou && !card.thankYou) return false;
    if (filters.surveyLink && !card.surveyLink) return false;
    if (q) {
      const haystack = `${card.name}\n${card.oneLiner}\n${card.tags.map((t) => t.text).join("\n")}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Regional pack for a card's questions, honouring the shop's country. */
export function catalogRegion(country: string | null): RegionPack {
  return regionPackFor(country);
}

/**
 * A template's default placements mapped to the survey config's placement ids.
 *
 * The template type uses `survey_link` (a shopper-facing name); the compiled
 * config uses `link` for the same placement. One mapping keeps the two from
 * drifting.
 */
export const TEMPLATE_PLACEMENT_MAP = {
  thank_you: "thank_you",
  order_status: "order_status",
  survey_link: "link",
} as const;

export function templatePlacements(template: TemplateDefinition): Array<"thank_you" | "order_status" | "link"> {
  return template.defaults.placements.map((p) => TEMPLATE_PLACEMENT_MAP[p]);
}

// ---------------------------------------------------------------------------
// Detail page (T2)
// ---------------------------------------------------------------------------

export type CatalogQuestion = {
  key: string;
  type: TemplateQuestion["type"];
  text: string;
  helpText: string | null;
  required: boolean;
  optionalInSetup: boolean;
  /** Pack id when the question uses an answer pack, else null. */
  packId: string | null;
  packOptions: Array<{ key: string; label: string }>;
  /** The parent question key this question is shown after, or null. */
  showIfParentKey: string | null;
  /** Parent option keys that trigger this question ("Only if …"). */
  showIfOptionKeys: string[];
  showIfMin: number | null;
  showIfMax: number | null;
};

export type CatalogIdea = { id: string; text: string };

export type CatalogDetail = {
  id: string;
  name: string;
  oneLiner: string;
  category: TemplateCategory;
  tags: CatalogTag[];
  learn: string[];
  questions: CatalogQuestion[];
  /** Packs the template can use, keyed for the "Answers for:" select. */
  packFamily: PackFamily | null;
  goodToKnow: string[];
  ideas: CatalogIdea[];
  hasSmartActions: boolean;
  popularIn: readonly string[];
  planLocked: boolean;
  requiredPlan: CatalogPlan;
  liteQuestionCount: number;
  /** Whether a Free (Lite) version exists. */
  hasLite: boolean;
};

function questionFromTemplate(
  locale: string,
  region: RegionPack,
  q: TemplateQuestion,
): CatalogQuestion {
  let packId: string | null = null;
  let packOptions: Array<{ key: string; label: string }> = [];
  let packQuestionText: string | null = null;
  if (q.pack) {
    const pack: Pack = packFor(q.pack, region);
    packId = pack.id;
    packOptions = pack.options.map((o) => ({ key: o.key, label: templateText(locale, o.labelKey) }));
    if (pack.questionTextKey) packQuestionText = templateText(locale, pack.questionTextKey);
  }

  return {
    key: q.key,
    type: q.type,
    // A profile question's text is the chosen industry's own question, so it
    // comes from the pack, not the template.
    text: packQuestionText ?? templateText(locale, q.textKey),
    helpText: q.helpTextKey ? templateText(locale, q.helpTextKey) : null,
    required: q.required,
    optionalInSetup: q.optionalInSetup ?? false,
    packId,
    packOptions,
    showIfParentKey: q.showIf?.questionKey ?? null,
    showIfOptionKeys: q.showIf?.optionKeys ?? [],
    showIfMin: q.showIf?.min ?? null,
    showIfMax: q.showIf?.max ?? null,
  };
}

export function catalogDetail(options: CatalogOptions & { id: string }): CatalogDetail | null {
  const template = templateById(options.id);
  if (!template) return null;
  const region = catalogRegion(options.country);
  const locale = options.locale;

  const cards = catalogCards(options);
  const card = cards.find((c) => c.id === template.id);

  const packQuestion = template.questions.find((q) => q.pack);
  return {
    id: template.id,
    name: templateText(locale, template.nameKey),
    oneLiner: templateText(locale, template.oneLinerKey),
    category: template.category,
    tags: (template.outcomeTags.filter(isTagId)).map((id) => tagText(locale, id)),
    learn: template.learnKeys.map((key) => templateText(locale, key)),
    questions: template.questions.map((q) => questionFromTemplate(locale, region, q)),
    packFamily: packQuestion?.pack ?? null,
    goodToKnow: (template.goodToKnowKeys ?? []).map((key) => templateText(locale, key)),
    ideas: template.ideas.map((id) => ({ id, text: templateText(locale, `ideas.${id}`) })),
    hasSmartActions: (template.smartActions ?? []).length > 0,
    popularIn: template.popularIn ?? [],
    planLocked: card?.planLocked ?? false,
    requiredPlan: templateRequiredPlan(template),
    liteQuestionCount: template.liteQuestionKeys.length,
    hasLite: card?.hasLite ?? templateHasFreeVersion(template),
  };
}

// ---------------------------------------------------------------------------
// Seasonal spotlight (T15)
// ---------------------------------------------------------------------------

export type Spotlight = {
  seasonId: SeasonId;
  templateId: string;
  banner: string;
};

/**
 * The active seasonal spotlight for a shop, or null.
 *
 * Evaluated entirely in the admin from the season table, the date in the shop's
 * timezone and the shop's region — no database, no network.
 */
export function currentSpotlight(options: {
  locale: string;
  region: RegionPack;
  now: Date;
  timeZone?: string;
}): Spotlight | null {
  const season: Season | null = activeSeason(options.region, options.now, options.timeZone ?? "UTC");
  if (!season) return null;
  return {
    seasonId: season.id,
    templateId: season.templateId,
    banner: templateText(options.locale, season.bannerKey),
  };
}
