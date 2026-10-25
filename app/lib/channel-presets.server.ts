import { PRESET_LABEL_KEYS } from "@shared/templates/channel-presets";
import { TEMPLATE_LOCALES, templateText } from "@shared/templates/locales";

/**
 * The wording of every generic preset answer ("Friend or family", "Podcast"):
 * in the merchant's language, and in every other template language as a
 * translation, so buyers read it in their checkout language.
 *
 * Built on the server because the template wording is not in the browser
 * bundle; the market lists themselves (`CHANNEL_MARKETS`) are small and are.
 */
export type PresetLabels = Record<string, { label: string; translations: Record<string, string> }>;

export function presetLabels(locale: string): PresetLabels {
  const base = TEMPLATE_LOCALES.includes(locale) ? locale : "en";
  const out: PresetLabels = {};
  for (const key of PRESET_LABEL_KEYS) {
    const label = templateText(base, key);
    const translations: Record<string, string> = {};
    for (const code of TEMPLATE_LOCALES) {
      if (code === base) continue;
      const text = templateText(code, key);
      // As templates do: a translation identical to the default is not stored.
      if (text && text !== label) translations[code] = text;
    }
    out[key] = { label, translations };
  }
  return out;
}
