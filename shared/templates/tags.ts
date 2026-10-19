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
  "purchase_triggers",
  "brand_presence",
  "discount_reliance",
  "product_discovery",
  "contact_channels",
  "other_stores",
  "subscription_interest",
  "open_feedback",
  "creator_podcast",
  "social_detail",
  "search_terms",
  "offline_channels",
  "message_impact",
  "review_sources",
  "payment_methods",
  "buyer_questions",
  "shipping_cost",
  "cross_border",
  "referral_intent",
  "next_purchase",
  "sustainability",
  "use_cases",
  "household",
  "life_moments",
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
  purchase_triggers: "Shows what brought buyers today",
  brand_presence: "Shows where buyers see you",
  discount_reliance: "Checks if discounts drive sales",
  product_discovery: "Shows how buyers find products",
  contact_channels: "Learns how to reach buyers",
  other_stores: "Finds where else buyers shop",
  subscription_interest: "Finds subscription buyers",
  open_feedback: "Collects open feedback",
  creator_podcast: "Names podcasts and creators",
  social_detail: "Shows which social posts work",
  search_terms: "Shows what buyers searched",
  offline_channels: "Tracks word of mouth and offline",
  message_impact: "Shows if emails and texts sell",
  review_sources: "Shows where buyers read reviews",
  payment_methods: "Spots missing payment methods",
  buyer_questions: "Collects pre-purchase questions",
  shipping_cost: "Shows how shipping cost lands",
  cross_border: "Checks duties are clear abroad",
  referral_intent: "Finds buyers ready to refer",
  next_purchase: "Shows what buyers want next",
  sustainability: "Shows which green steps count",
  use_cases: "Learns how products are used",
  household: "Profiles buyer households",
  life_moments: "Spots life moments behind orders",
};

/** An outcome tag uses the success (green) tone. Never on meta or plan badges. */
export const OUTCOME_TAG_TONE = "success" as const;
