/**
 * Ideas to try (T12) — rule-based suggestion cards.
 *
 * Pure rules over aggregate numbers. No AI, no network. Wording is always a
 * suggestion ("may", "consider", "can"), never a promise, and no competitor is
 * named. Text is localized; parameters are formatted by `Intl` at render time.
 *
 * Dependency-free.
 */

/** The confidence labels (T9), ordered weakest to strongest. */
export const CONFIDENCE_LEVELS = ["too_early", "early_signal", "getting_clear", "reliable"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  too_early: 0,
  early_signal: 1,
  getting_clear: 2,
  reliable: 3,
};

export function confidenceAtLeast(actual: ConfidenceLevel, min: ConfidenceLevel): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[min];
}

/** Aggregate numbers an idea rule may read. Never raw answers, never PII. */
export type IdeaStats = {
  /** Answers to the main (first choice-type) question. */
  n: number;
  confidence: ConfidenceLevel;
  /** Choice main question: share (0–1) per option key. */
  shares: Record<string, number>;
  topOptionKey: string | null;
  topShare: number;
  /** The labelling of the top option, resolved by the caller from the survey. */
  optionLabels: Record<string, string>;
  /** Numeric main question. */
  average: number | null;
  /** Per-product breakdown, when the template asks for it (T8). */
  byProduct: Array<{
    productId: string;
    productTitle: string;
    n: number;
    confidence: ConfidenceLevel;
    shares: Record<string, number>;
    topOptionKey: string | null;
    topShare: number;
    optionLabels: Record<string, string>;
  }>;
};

export type IdeaRule = {
  id: string;
  minConfidence: ConfidenceLevel;
  /** Whether the rule applies per product rather than per survey. */
  perProduct?: boolean;
  /** Fire for this aggregate. */
  when: (stats: IdeaStats) => boolean;
  /** Text parameters. Strings/numbers only. */
  params: (stats: IdeaStats, product?: IdeaStats["byProduct"][number]) => Record<string, string | number>;
  /** i18n key (`ideas.<id>`). */
  textKey: string;
};

/** Sum of shares across a set of option keys. */
function shareOf(shares: Record<string, number>, keys: readonly string[]): number {
  return keys.reduce((sum, key) => sum + (shares[key] ?? 0), 0);
}

/** A label for an option key, falling back to the key itself. */
function labelOf(stats: IdeaStats, key: string | null): string {
  if (!key) return "";
  return stats.optionLabels[key] ?? key;
}

export const IDEA_RULES: Record<string, IdeaRule> = {
  channel_share: {
    id: "channel_share",
    minConfidence: "reliable",
    when: (s) => s.topShare >= 0.4 && s.topOptionKey !== null,
    params: (s) => ({ channel: labelOf(s, s.topOptionKey) }),
    textKey: "ideas.channel_share",
  },
  slow_decision: {
    id: "slow_decision",
    minConfidence: "getting_clear",
    when: (s) => shareOf(s.shares, ["this_month", "longer_ago"]) >= 0.5,
    params: () => ({}),
    textKey: "ideas.slow_decision",
  },
  nudge_count: {
    id: "nudge_count",
    minConfidence: "getting_clear",
    when: (s) => shareOf(s.shares, ["three_to_five", "more_than_five"]) >= 0.5,
    params: () => ({}),
    textKey: "ideas.nudge_count",
  },
  no_ad_recall: {
    id: "no_ad_recall",
    minConfidence: "getting_clear",
    when: (s) => shareOf(s.shares, ["none_of_these"]) >= 0.5,
    params: () => ({}),
    textKey: "ideas.no_ad_recall",
  },
  switch_price: {
    id: "switch_price",
    minConfidence: "getting_clear",
    when: (s) => s.topOptionKey === "better_price",
    params: () => ({}),
    textKey: "ideas.switch_price",
  },
  trust_top: {
    id: "trust_top",
    minConfidence: "getting_clear",
    when: (s) => s.topOptionKey !== null && s.topShare > 0,
    params: (s) => ({ answer: labelOf(s, s.topOptionKey) }),
    textKey: "ideas.trust_top",
  },
  videos_matter: {
    id: "videos_matter",
    minConfidence: "getting_clear",
    when: (s) => shareOf(s.shares, ["videos"]) >= 0.25,
    params: () => ({}),
    textKey: "ideas.videos_matter",
  },
  blocker_share: {
    id: "blocker_share",
    minConfidence: "getting_clear",
    when: (s) => s.topOptionKey !== null && s.topOptionKey !== "no_easy" && s.topShare >= 0.2,
    params: (s) => ({ blocker: labelOf(s, s.topOptionKey), percent: Math.round(s.topShare * 100) }),
    textKey: "ideas.blocker_share",
  },
  price_high: {
    id: "price_high",
    minConfidence: "reliable",
    perProduct: true,
    when: (s) => shareOf(s.shares, ["a_little_high", "too_high"]) >= 0.4,
    params: (s, product) => ({ product: product?.productTitle ?? "" }),
    textKey: "ideas.price_high",
  },
  delivery_unsure: {
    id: "delivery_unsure",
    minConfidence: "getting_clear",
    when: (s) => shareOf(s.shares, ["maybe", "not_sure"]) >= 0.15,
    params: (s) => ({ percent: Math.round(shareOf(s.shares, ["maybe", "not_sure"]) * 100) }),
    textKey: "ideas.delivery_unsure",
  },
  fit_unsure: {
    id: "fit_unsure",
    minConfidence: "getting_clear",
    perProduct: true,
    when: (s) => shareOf(s.shares, ["not_sure"]) >= 0.25,
    params: (s, product) => ({ product: product?.productTitle ?? "" }),
    textKey: "ideas.fit_unsure",
  },
  delivery_fast: {
    id: "delivery_fast",
    minConfidence: "getting_clear",
    when: (s) => shareOf(s.shares, ["within_2_days"]) >= 0.4,
    params: () => ({}),
    textKey: "ideas.delivery_fast",
  },
  nps_detractors: {
    id: "nps_detractors",
    minConfidence: "reliable",
    when: (s) => (s.shares["detractor"] ?? 0) >= 0.2,
    params: (s) => ({ percent: Math.round((s.shares["detractor"] ?? 0) * 100) }),
    textKey: "ideas.nps_detractors",
  },
};

export type ResolvedIdea = {
  /** Unique per (rule, product). */
  key: string;
  ruleId: string;
  textKey: string;
  params: Record<string, string | number>;
  productId?: string;
  /** Answers the idea is based on. */
  basedOn: number;
};

/**
 * Resolve the idea rules for a survey to the cards to show.
 *
 * Survey-scoped rules first, then per-product rules (one card per product).
 * Callers cap the display (Overview shows at most 2).
 */
export function computeIdeas(stats: IdeaStats, ruleIds: readonly string[]): ResolvedIdea[] {
  const out: ResolvedIdea[] = [];

  for (const id of ruleIds) {
    const rule = IDEA_RULES[id];
    if (!rule || rule.perProduct) continue;
    if (!confidenceAtLeast(stats.confidence, rule.minConfidence)) continue;
    if (!rule.when(stats)) continue;
    out.push({
      key: rule.id,
      ruleId: rule.id,
      textKey: rule.textKey,
      params: rule.params(stats),
      basedOn: stats.n,
    });
  }

  for (const id of ruleIds) {
    const rule = IDEA_RULES[id];
    if (!rule || !rule.perProduct) continue;
    for (const product of stats.byProduct) {
      if (!confidenceAtLeast(product.confidence, rule.minConfidence)) continue;
      const productStats: IdeaStats = {
        ...stats,
        shares: product.shares,
        topOptionKey: product.topOptionKey,
        topShare: product.topShare,
        optionLabels: product.optionLabels,
        n: product.n,
      };
      if (!rule.when(productStats)) continue;
      out.push({
        key: `${rule.id}:${product.productId}`,
        ruleId: rule.id,
        textKey: rule.textKey,
        params: rule.params(productStats, product),
        productId: product.productId,
        basedOn: product.n,
      });
    }
  }

  return out;
}
