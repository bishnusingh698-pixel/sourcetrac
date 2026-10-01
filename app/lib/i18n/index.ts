import { createInstance, type i18n as I18nInstance } from "i18next";

import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import nl from "./locales/nl.json";
import ptBR from "./locales/pt-BR.json";
import sv from "./locales/sv.json";
import zhCN from "./locales/zh-CN.json";

import { DEFAULT_LANGUAGE, languageFor, type LanguageCode } from "./languages";

/**
 * Per-request i18n.
 *
 * ## Why a new instance per request, and not a module-level singleton
 *
 * This is a multi-tenant embedded app. Every merchant shares one Node process and
 * one module registry. A singleton created once at import time would keep
 * whatever language the first request asked for, so a German merchant's session
 * could render German for a Japanese merchant on the next request — a data leak
 * between stores, and a wrong `<html lang>` for screen readers.
 *
 * `createInstance()` gives each request its own state. It costs one object per
 * request, which is negligible next to the database round trip the same loader
 * already performs.
 *
 * ## Why resources are bundled rather than loaded per request
 *
 * All ten bundles are small and there is no network hop. Loading them lazily
 * would add a round trip to the critical path of every page for no benefit, and
 * a lazily-loaded language is exactly how you get a flash of English on first
 * paint.
 */

const RESOURCES = {
  en: { translation: en },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
  "pt-BR": { translation: ptBR },
  "zh-CN": { translation: zhCN },
  ja: { translation: ja },
  it: { translation: it },
  nl: { translation: nl },
  sv: { translation: sv },
} as const;

/**
 * Shape of the English bundle. Every other language is checked against this at
 * build time via `Translation = typeof en`, so a key added to English and
 * forgotten elsewhere is a type error, not a raw key in the UI.
 */
export type Translation = typeof en;

/** A `t` function narrowed to our known key space. */
export type TFunction = I18nInstance["t"];

/**
 * Create an i18n instance for one request.
 *
 * `fallbackLng: "en"` means a key missing from `de` renders the English string
 * rather than the raw key, which is what the "raw keys must never appear in the
 * UI" requirement needs. `returnNull: false` is required for the same reason:
 * without it i18next returns `null` for a missing key and React renders nothing.
 */
export function createI18n(language: LanguageCode) {
  const instance = createInstance();

  instance.init({
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: Object.keys(RESOURCES),
    ns: ["translation"],
    defaultNS: "translation",
    interpolation: {
      // React escapes text for us. Escaping again would show literal `&amp;`
      // in the UI, and interpolating HTML is how translation files become an
      // injection vector.
      escapeValue: false,
    },
    returnNull: false,
    react: { useSuspense: false },
  });

  return instance;
}

/** Create an instance and return its `t`, which is all a route needs. */
export function createTranslator(language: LanguageCode): TFunction {
  return createI18n(language).getFixedT(language, "translation");
}

/** The BCP 47 tag to hand to `Intl` for a language code. */
export function intlLocaleFor(language: LanguageCode): string {
  return languageFor(language).intlLocale;
}

export { DEFAULT_LANGUAGE, languageFor, resolveLanguage, LANGUAGES } from "./languages";
export type { LanguageCode, Language } from "./languages";
export { RESOURCES };