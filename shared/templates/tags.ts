/**
 * Outcome tags — the fixed dictionary of green tags.
 *
 * Tags describe what a template SHOWS OR DOES, never a promised result. Built
 * for Shopify forbids outcome promises, so "Spots unsure deliveries" is allowed
 * and "Cuts failed deliveries by 20%" is not.
 *
 * The English text and every tooltip live in `shared/templates/locales/<code>.json`
 * under `tags.<id>` / `tags.<id>.tip`, translated in all 10 APP_LOCALES. This
 * module holds only the stable ids, so the gallery can filter by them and the
 * wording stays consistent.
 */

/** Every outcome tag id. Adding one requires text + tooltip in all 10 locales. */
export const TAG_IDS = [
  "best_channels",
  "time_to_buy",
  "nudge_count",
  "ad_recall",
  "switch_reasons",
  "rival_names",
  "trust_builders",
  "page_convincers",
  "page_gaps",
  "checkout_blockers",
  "price_feel",
  "delivery_risk",
  "delivery_time",
  "fit_doubts",
  "delivery_expectations",
  "buyer_values",
  "unhappy_buyers",
  "repeat_intent",
  "loyalty",
  "return_reasons",
  "gift_buyers",
  "gift_timing",
  "reorder_timing",
  "profiles",
  "content_wishes",
  "business_buyers",
  "missing_products",
  "after_delivery",
] as const;

export type TagId = (typeof TAG_IDS)[number];

const TAG_SET: ReadonlySet<string> = new Set(TAG_IDS);

export function isTagId(value: string): value is TagId {
  return TAG_SET.has(value);
}

/** The English reference text, kept here only so the ≤ 32-char rule is testable
 * without loading a bundle. The rendered text is always the localized one. */
export const TAG_EN: Readonly<Record<TagId, string>> = {
  best_channels: "Finds your best channels",
  time_to_buy: "Shows time to buy",
  nudge_count: "Counts nudges to buy",
  ad_recall: "Tracks ad recall",
  switch_reasons: "Learns why buyers switch",
  rival_names: "Names your rivals",
  trust_builders: "Shows what builds trust",
  page_convincers: "Shows what convinced buyers",
  page_gaps: "Finds product page gaps",
  checkout_blockers: "Finds checkout blockers",
  price_feel: "Checks how prices feel",
  delivery_risk: "Spots unsure deliveries",
  delivery_time: "Plans delivery timing",
  fit_doubts: "Flags sizing doubts",
  delivery_expectations: "Checks delivery expectations",
  buyer_values: "Learns buyer values",
  unhappy_buyers: "Spots unhappy buyers",
  repeat_intent: "Checks repeat intent",
  loyalty: "Measures loyalty",
  return_reasons: "Learns why buyers return",
  gift_buyers: "Finds gift buyers",
  gift_timing: "Times gift reminders",
  reorder_timing: "Plans reorder reminders",
  profiles: "Builds customer profiles",
  content_wishes: "Learns what buyers want to hear",
  business_buyers: "Finds business buyers",
  missing_products: "Finds missing products",
  after_delivery: "Checks product after delivery",
};

/** An outcome tag uses the success (green) tone. Never on meta or plan badges. */
export const OUTCOME_TAG_TONE = "success" as const;
