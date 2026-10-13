/**
 * Pure helpers for Quick setup (T3).
 *
 * Kept out of the route so they can be unit-tested without a database, Shopify
 * session or React. `buildWizardTargeting` and `buildWizardSyncOptions` are the
 * two pieces of the wizard that decide what actually gets stored.
 */

import { LIMITS } from "../survey-rules";
import type { Placement, Targeting } from "../survey-config";
import { SMART_ACTION_PRESETS } from "./smart-actions";
import type { PackFamily, TemplateDefinition } from "./types";

export type WizardConfig = {
  name?: string;
  toggles?: Record<string, boolean>;
  overrides?: Record<string, { text?: string; helpText?: string; placeholder?: string; options?: Record<string, string> }>;
  profileFamily?: PackFamily;
  lite?: boolean;
  audience?: Targeting["customerType"];
  placements?: Placement[];
  samplePercent?: number;
  paymentManualOnly?: boolean;
  productsOnly?: boolean;
  productIds?: string[];
  rotation?: boolean;
  learnAndStop?: boolean;
  smartActions?: string[];
};

/** Assemble targeting from the wizard's step-2 answers. */
export function buildWizardTargeting(config: {
  audience?: Targeting["customerType"];
  samplePercent?: number;
  paymentManualOnly?: boolean;
  productsOnly?: boolean;
  productIds?: string[];
}): Targeting {
  const targeting: Targeting = {};
  if (config.audience && config.audience !== "everyone") targeting.customerType = config.audience;
  if (config.samplePercent != null && config.samplePercent < 100) targeting.samplePercent = config.samplePercent;
  if (config.paymentManualOnly) targeting.paymentManualOnly = true;
  if (config.productsOnly && config.productIds && config.productIds.length > 0) {
    targeting.productIds = config.productIds.slice(0, LIMITS.MAX_TARGET_PRODUCTS);
  }
  return targeting;
}

/**
 * Turn enabled smart-action toggles into sync settings (T13).
 *
 * The per-answer tag is built from option keys in `sync.server.ts`, so a preset
 * stores its literal name template (e.g. `delivery-check:{optionKey}`) with
 * `{optionKey}` kept in place. Writing `{channel}` into the tag here, as an
 * earlier draft did, produced a fixed tag rather than one per answer.
 */
export function buildWizardSyncOptions(
  template: Pick<TemplateDefinition, "smartActions">,
  config: { smartActions?: string[] },
): Record<string, unknown> {
  const enabled = new Set(config.smartActions ?? []);
  if (enabled.size === 0) return {};

  const orderTags: string[] = [];
  const customerTags: string[] = [];
  const metafields: Array<{ namespace: string; key: string; type?: string }> = [];
  const presets: string[] = [];

  for (const id of template.smartActions ?? []) {
    if (!enabled.has(id)) continue;
    const preset = SMART_ACTION_PRESETS[id];
    if (!preset) continue;
    presets.push(id);
    if (preset.kind === "order_tag") orderTags.push(preset.name);
    else if (preset.kind === "customer_tag") customerTags.push(preset.name);
    else {
      metafields.push({
        namespace: "sourcetrac",
        key: (preset.name.replace(/\{optionKey\}/g, "") || "profile").replace(/[-:]/g, "_").slice(0, 64),
        type: "single_line_text_field",
      });
    }
  }

  return {
    orderTags: orderTags.length ? orderTags.slice(0, 4) : undefined,
    customerTags: customerTags.length ? customerTags.slice(0, 4) : undefined,
    metafields: metafields.length ? metafields.slice(0, 4) : undefined,
    presets: presets.length ? presets : undefined,
  };
}
