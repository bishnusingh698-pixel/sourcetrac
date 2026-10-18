/**
 * Smart actions (T13) — preset, opt-in Shopify writes per template.
 *
 * Each maps answers to order tags, customer tags or customer metafields. They
 * reuse the Phase 7 sync machinery (`app/lib/sync.server.ts`). Off by default;
 * the merchant turns each one on. Requires the Pro plan and the needed scopes.
 *
 * Tag text is built ONLY from option keys, never from free text or translated
 * labels, so a tag is identical in every language.
 */

import { stableQuestionId } from "./resolve";
import { templateById } from "./index";

/** What a preset writes. */
export type SmartActionKind = "order_tag" | "customer_tag" | "customer_metafield";

export type SmartActionPreset = {
  id: string;
  kind: SmartActionKind;
  /** The question whose answer drives the write. */
  questionKey: string;
  /**
   * Tag/field name. `{prefix}` and `{optionKey}` are substituted. A tag value
   * is `prefix:optionKey` (max 40 chars, lowercase ASCII).
   */
  name: string;
  /**
   * Optional map from an option key to a fixed written value. When absent the
   * option key itself is used. Metafield values are numeric where noted.
   */
  valueMap?: Record<string, string>;
  /** Only write when the answer matches one of these option keys. */
  onlyForOptionKeys?: string[];
  /**
   * Only write when a *different* question's answer matches one of these option
   * keys. Used by the reorder presets, where the write is driven by the reorder
   * window but only when the buyer opted into a reminder.
   */
  gateQuestionKey?: string;
  gateOptionKeys?: string[];
  /**
   * Only write for a buyer's first order. The merchant can widen the survey's
   * audience, so a "first order" tag cannot rely on the targeting alone.
   */
  requiresFirstOrder?: boolean;
  /**
   * For numeric questions (rating / NPS): write when the value falls in a band.
   * Checked in order; the first matching band wins.
   */
  numericBands?: Array<{ min?: number; max?: number; value: string }>;
  /** The i18n key for the example line ("Adds the tag … to the order"). */
  exampleKey: string;
  /** The scope required, from `app/lib/scopes.server.ts`. */
  scope: "write_orders" | "write_customers";
};

export const SMART_ACTION_PRESETS: Record<string, SmartActionPreset> = {
  channel_order_tag: {
    id: "channel_order_tag",
    kind: "order_tag",
    questionKey: "q_channel",
    name: "found:{optionKey}",
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  delivery_status_order_tag: {
    id: "delivery_status_order_tag",
    kind: "order_tag",
    questionKey: "q_availability",
    name: "delivery-check:{optionKey}",
    valueMap: { yes: "confirmed", maybe: "maybe", not_sure: "unsure" },
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  delivery_time_order_tag: {
    id: "delivery_time_order_tag",
    kind: "order_tag",
    questionKey: "q_delivery_time",
    name: "delivery-time:{optionKey}",
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  fit_unsure_order_tag: {
    id: "fit_unsure_order_tag",
    kind: "order_tag",
    questionKey: "q_fit_sure",
    name: "fit:unsure",
    onlyForOptionKeys: ["not_sure"],
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  needs_by_date_order_tag: {
    id: "needs_by_date_order_tag",
    kind: "order_tag",
    questionKey: "q_needs_date",
    name: "needs-by-date",
    onlyForOptionKeys: ["yes"],
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  first_order_low_rating_order_tag: {
    id: "first_order_low_rating_order_tag",
    kind: "order_tag",
    questionKey: "q_ease",
    name: "first-order:low-rating",
    numericBands: [{ max: 2, value: "low-rating" }],
    requiresFirstOrder: true,
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  bulk_interest_order_tag: {
    id: "bulk_interest_order_tag",
    kind: "order_tag",
    questionKey: "q_bulk_price",
    name: "bulk-interest",
    onlyForOptionKeys: ["yes"],
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  nps_customer_tag: {
    id: "nps_customer_tag",
    kind: "customer_tag",
    questionKey: "q_nps",
    name: "nps:{optionKey}",
    // An NPS answer is a number, not an option, so the band picks the label.
    numericBands: [
      { min: 9, value: "promoter" },
      { min: 7, max: 8, value: "passive" },
      { max: 6, value: "detractor" },
    ],
    exampleKey: "smart_actions.example_customer_tag",
    scope: "write_customers",
  },
  gifter_customer_tag: {
    id: "gifter_customer_tag",
    kind: "customer_tag",
    questionKey: "q_recipient",
    name: "gifter",
    onlyForOptionKeys: ["gift", "both"],
    exampleKey: "smart_actions.example_customer_tag",
    scope: "write_customers",
  },
  gift_occasion_customer_tag: {
    id: "gift_occasion_customer_tag",
    kind: "customer_tag",
    questionKey: "q_occasion",
    name: "gift-occasion:{optionKey}",
    exampleKey: "smart_actions.example_customer_tag",
    scope: "write_customers",
  },
  reorder_customer_tag: {
    id: "reorder_customer_tag",
    kind: "customer_tag",
    // The plan's tag carries the expected reorder window, gated on the buyer
    // having said a reminder would help.
    questionKey: "q_lasts",
    name: "reorder:{optionKey}",
    // "Not sure" writes nothing; the tag's value is the window's own option key.
    onlyForOptionKeys: ["two_weeks", "about_a_month", "two_three_months", "longer"],
    gateQuestionKey: "q_reorder_reminder",
    gateOptionKeys: ["yes"],
    exampleKey: "smart_actions.example_customer_tag",
    scope: "write_customers",
  },
  profile_customer_tag: {
    id: "profile_customer_tag",
    kind: "customer_tag",
    questionKey: "q_profile",
    name: "profile:{optionKey}",
    exampleKey: "smart_actions.example_customer_tag",
    scope: "write_customers",
  },
  profile_customer_metafield: {
    id: "profile_customer_metafield",
    kind: "customer_metafield",
    questionKey: "q_profile",
    name: "sourcetrac.profile",
    exampleKey: "smart_actions.example_customer_metafield",
    scope: "write_customers",
  },
  reorder_window_metafield: {
    id: "reorder_window_metafield",
    kind: "customer_metafield",
    questionKey: "q_lasts",
    name: "sourcetrac.reorder_window_days",
    valueMap: { two_weeks: "14", about_a_month: "30", two_three_months: "75", longer: "120" },
    // Written only when the buyer asked for a reorder reminder (plan, Q2 = Yes).
    gateQuestionKey: "q_reorder_reminder",
    gateOptionKeys: ["yes"],
    exampleKey: "smart_actions.example_customer_metafield",
    scope: "write_customers",
  },
  trigger_order_tag: {
    id: "trigger_order_tag",
    kind: "order_tag",
    questionKey: "q_today",
    name: "trigger:{optionKey}",
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  offer_order_tag: {
    id: "offer_order_tag",
    kind: "order_tag",
    questionKey: "q_offer",
    // Only the orders a discount helped: those are the ones a merchant checks
    // before deciding whether an offer is worth its margin.
    name: "offer:{optionKey}",
    onlyForOptionKeys: ["needed", "helped"],
    exampleKey: "smart_actions.example_order_tag",
    scope: "write_orders",
  },
  subscribe_interest_customer_tag: {
    id: "subscribe_interest_customer_tag",
    kind: "customer_tag",
    questionKey: "q_subscribe",
    name: "subscribe-interest:{optionKey}",
    onlyForOptionKeys: ["monthly", "every_2_3_months", "with_discount"],
    exampleKey: "smart_actions.example_customer_tag",
    scope: "write_customers",
  },
};

export function smartActionPreset(id: string): SmartActionPreset | undefined {
  return SMART_ACTION_PRESETS[id];
}

// ---------------------------------------------------------------------------
// Resolving a preset against an answer (T13)
// ---------------------------------------------------------------------------

/** One stored answer, as the resolver needs it. */
export type SmartActionAnswer = {
  questionId: string;
  optionIds: string[];
  numberValue: number | null;
};

/** The concrete Shopify writes a survey's enabled presets produce for one answer. */
export type ResolvedSmartActions = {
  orderTags: string[];
  customerTags: string[];
  customerMetafields: Array<{ namespace: string; key: string; value: string }>;
};

/**
 * Recover the template option key behind a stored option id.
 *
 * A merchant option id is `stableQuestionId(...)_optionKey`, so stripping the
 * question-id prefix yields the key. (A yes/no answer never stores an option id;
 * see `answerOptionKey`.)
 */
function optionKeyFor(questionId: string, optionId: string): string {
  const prefix = `${questionId}_`;
  return optionId.startsWith(prefix) ? optionId.slice(prefix.length) : optionId;
}

/**
 * Recover the answer's template option key, regardless of how the question type
 * stores it.
 *
 * Choice questions keep option ids. Yes/no is defined as *numeric* by
 * `shared/survey-rules.ts` (yes = 1, no = 0), so read `numberValue` first; the
 * checkout extension also mirrors the choice into `optionIds` (`["yes"]`), so
 * fall back to that when the number is absent. A future client that sends only
 * the canonical numeric field still matches (see the T13 note in AGENTS.md).
 */
function answerOptionKey(
  questionType: string | undefined,
  questionId: string,
  answer: SmartActionAnswer,
): string | null {
  if (questionType === "yes_no") {
    if (answer.numberValue === 1) return "yes";
    if (answer.numberValue === 0) return "no";
    const mirrored = answer.optionIds[0];
    return mirrored === "yes" || mirrored === "no" ? mirrored : null;
  }
  const optionId = answer.optionIds[0];
  if (!optionId) return null;
  return optionKeyFor(questionId, optionId);
}

/** `sourcetrac.profile` -> { namespace: "sourcetrac", key: "profile" }. */
function splitMetafieldName(name: string): { namespace: string; key: string } {
  const dot = name.indexOf(".");
  if (dot < 0) return { namespace: "sourcetrac", key: name.replace(/[-:]/g, "_").slice(0, 64) };
  return {
    namespace: name.slice(0, dot).replace(/[-:]/g, "_").slice(0, 64),
    key: name.slice(dot + 1).replace(/[-:]/g, "_").slice(0, 64),
  };
}

/**
 * Turn enabled preset ids plus a response's answers into concrete tags and
 * metafields.
 *
 * Pure and database-free, so it is unit-tested directly. Tags are built ONLY
 * from option keys (never free text or translated labels), so a tag is identical
 * in every language. The caller sanitises tags before sending them on.
 *
 * `questionId` for a preset's `questionKey` is `stableQuestionId(templateId, key)`.
 */
export function resolveSmartActionWrites(params: {
  templateId: string;
  presetIds: readonly string[];
  answers: readonly SmartActionAnswer[];
  /** From the Thank-you page; null/undefined when unknown. */
  isFirstOrder?: boolean | null;
}): ResolvedSmartActions {
  const out: ResolvedSmartActions = { orderTags: [], customerTags: [], customerMetafields: [] };
  if (!params.templateId || params.presetIds.length === 0) return out;

  const byQuestion = new Map<string, SmartActionAnswer>();
  for (const answer of params.answers) byQuestion.set(answer.questionId, answer);

  const template = templateById(params.templateId);
  const typeOf = (questionKey: string): string | undefined =>
    template?.questions.find((q) => q.key === questionKey)?.type;

  for (const id of params.presetIds) {
    const preset = SMART_ACTION_PRESETS[id];
    if (!preset) continue;
    // Unknown counts as "not a first order": the tag claims it is one.
    if (preset.requiresFirstOrder && params.isFirstOrder !== true) continue;
    const questionId = stableQuestionId(params.templateId, preset.questionKey);
    const answer = byQuestion.get(questionId);
    if (!answer) continue;

    // A cross-question gate: the reorder presets read the window but only write
    // when the buyer said a reminder would help.
    if (preset.gateQuestionKey && preset.gateOptionKeys) {
      const gateId = stableQuestionId(params.templateId, preset.gateQuestionKey);
      const gate = byQuestion.get(gateId);
      const gateKey = gate ? answerOptionKey(typeOf(preset.gateQuestionKey), gateId, gate) : null;
      if (gateKey == null || !preset.gateOptionKeys.includes(gateKey)) continue;
    }

    // The answer's written value, from a numeric band or an option key.
    let value: string | null = null;
    if (preset.numericBands) {
      const n = answer.numberValue;
      if (n == null) continue;
      const band = preset.numericBands.find(
        (b) => (b.min == null || n >= b.min) && (b.max == null || n <= b.max),
      );
      if (!band) continue;
      value = band.value;
    } else {
      const key = answerOptionKey(typeOf(preset.questionKey), questionId, answer);
      if (key == null) continue;
      if (preset.onlyForOptionKeys && !preset.onlyForOptionKeys.includes(key)) continue;
      // A `valueMap` writes only for the keys it names, so e.g. the reorder
      // window leaves "Not sure" without a value rather than writing "not_sure".
      if (preset.valueMap && !(key in preset.valueMap)) continue;
      value = preset.valueMap?.[key] ?? key;
    }
    if (value == null) continue;

    if (preset.kind === "order_tag") out.orderTags.push(preset.name.replace("{optionKey}", value));
    else if (preset.kind === "customer_tag") out.customerTags.push(preset.name.replace("{optionKey}", value));
    else {
      // A metafield's value is the answer itself; `name` is only the field key.
      const { namespace, key } = splitMetafieldName(preset.name);
      out.customerMetafields.push({ namespace, key, value });
    }
  }

  return out;
}
