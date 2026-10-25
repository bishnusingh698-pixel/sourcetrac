import {
  marketForCountry,
  presetLabel,
  presetOptionTemplateKey,
  type ChannelMarket,
} from "@shared/templates/channel-presets";
import type { PresetLabels } from "~/lib/channel-presets.server";

/** An answer built from a market preset, in the editor's option shape. */
export type PresetAnswer = {
  key: string;
  label: string;
  translations: Record<string, string>;
  templateKey: string;
};

/**
 * A market's answers, worded for the merchant (generic ones translated for
 * every buyer language). Browser-safe: the wording arrives from the server as
 * `PresetLabels`.
 */
export function presetAnswers(
  market: ChannelMarket,
  labels: PresetLabels,
  questionTemplateKey: string | null | undefined,
): PresetAnswer[] {
  return market.options.map((option) => {
    const generic = option.labelKey ? labels[option.labelKey] : undefined;
    return {
      key: option.key,
      label: presetLabel(option, (key) => labels[key]?.label ?? key),
      translations: generic ? { ...generic.translations } : {},
      templateKey: presetOptionTemplateKey(questionTemplateKey, option.key),
    };
  });
}

/** The answers for a country's market. */
export function presetAnswersForCountry(
  country: string | null,
  labels: PresetLabels,
  questionTemplateKey: string | null | undefined,
): { market: ChannelMarket; answers: PresetAnswer[] } {
  const market = marketForCountry(country);
  return { market, answers: presetAnswers(market, labels, questionTemplateKey) };
}

/** The channel key an existing answer stands for, to match it against a preset. */
export function answerKeyOf(option: { label: string; templateKey?: string | null }): string {
  const key = option.templateKey ?? "";
  const tail = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key.includes("_") ? null : key;
  return tail || option.label.trim().toLowerCase();
}

/**
 * Merge preset answers into a question's answers.
 *
 * - `replace`: the preset's answers, in its order. An answer the question
 *   already had (same label, ignoring case) keeps its id, so its results stay
 *   with it; the rest are removed (the server archives any with answers).
 * - `add`: the existing answers, then any preset answer not already there.
 *
 * Never more than `max` answers.
 */
export function mergePresetAnswers<O extends { id: string; label: string }>(
  existing: readonly O[],
  preset: readonly PresetAnswer[],
  mode: "replace" | "add",
  max: number,
  build: (answer: PresetAnswer) => O,
): O[] {
  const byLabel = new Map(existing.map((o) => [o.label.trim().toLowerCase(), o]));
  if (mode === "replace") {
    return preset.slice(0, max).map((answer) => byLabel.get(answer.label.trim().toLowerCase()) ?? build(answer));
  }
  const out = [...existing];
  for (const answer of preset) {
    if (out.length >= max) break;
    if (byLabel.has(answer.label.trim().toLowerCase())) continue;
    out.push(build(answer));
  }
  return out;
}
