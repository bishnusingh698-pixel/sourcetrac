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
 * Only the preset ids are stored. The concrete tag/metafield names depend on the
 * buyer's answer, so they are built per response by `resolveSmartActionWrites`
 * (`shared/templates/smart-actions.ts`) — writing `{optionKey}` into a tag name
 * here, as an earlier draft did, would ship a literal `optionkey` tag.
 */
export function buildWizardSyncOptions(
  template: Pick<TemplateDefinition, "smartActions">,
  config: { smartActions?: string[] },
): Record<string, unknown> {
  const enabled = new Set(config.smartActions ?? []);
  if (enabled.size === 0) return {};

  const presets: string[] = [];
  for (const id of template.smartActions ?? []) {
    if (!enabled.has(id)) continue;
    if (!SMART_ACTION_PRESETS[id]) continue;
    presets.push(id);
  }

  return presets.length ? { presets } : {};
}
