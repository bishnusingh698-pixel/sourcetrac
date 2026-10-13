/**
 * Template locale loading.
 *
 * Template content lives in FLAT locale files (`locales/<code>.json`, dotted
 * keys) rather than i18next's nested bundles, because templates are read by
 * shared modules and tests, not just React. The files are imported statically so
 * Vite bundles exactly the languages we ship and there is no async load.
 *
 * Only the merchant's admin language (plus English as fallback) is ever selected
 * at runtime; all ten are bundled so the parity test can see them.
 */

import en from "./locales/en.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
import ptBR from "./locales/pt-BR.json";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";
import it from "./locales/it.json";
import nl from "./locales/nl.json";
import sv from "./locales/sv.json";

export type TemplateBundle = Record<string, string>;

export const TEMPLATE_BUNDLES: Record<string, TemplateBundle> = {
  en: en as TemplateBundle,
  de: de as TemplateBundle,
  fr: fr as TemplateBundle,
  es: es as TemplateBundle,
  "pt-BR": ptBR as TemplateBundle,
  "zh-CN": zhCN as TemplateBundle,
  ja: ja as TemplateBundle,
  it: it as TemplateBundle,
  nl: nl as TemplateBundle,
  sv: sv as TemplateBundle,
};

/** The English reference bundle, non-optional so callers never null-check it. */
export const TEMPLATE_BUNDLE_EN: TemplateBundle = en as TemplateBundle;

export const TEMPLATE_LOCALES = Object.keys(TEMPLATE_BUNDLES);

/**
 * Template text for a locale: the locale's own string, falling back to English,
 * then to the key itself (so a missing key is visible, never blank).
 */
export function templateText(locale: string, key: string): string {
  const bundle = TEMPLATE_BUNDLES[locale];
  return bundle?.[key] ?? TEMPLATE_BUNDLE_EN[key] ?? key;
}

/** A `t`-like function bound to one locale. */
export function templateTranslator(locale: string): (key: string) => string {
  return (key: string) => templateText(locale, key);
}

/**
 * Fill a template string's `{placeholder}`s from a params map.
 *
 * Template content uses single-brace placeholders (`{channel}`, `{percent}`),
 * unlike the admin bundle's `{{...}}`, because it is read by shared modules and
 * tests rather than i18next. An unknown placeholder is left as-is so a missing
 * param is visible rather than silently blank.
 */
export function interpolateTemplateText(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
