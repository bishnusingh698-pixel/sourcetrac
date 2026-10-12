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
    questionKey: "q_reorder_reminder",
    name: "reorder:{optionKey}",
    onlyForOptionKeys: ["yes"],
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
    exampleKey: "smart_actions.example_customer_metafield",
    scope: "write_customers",
  },
};

export function smartActionPreset(id: string): SmartActionPreset | undefined {
  return SMART_ACTION_PRESETS[id];
}
