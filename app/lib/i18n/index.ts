import { createInstance, type i18n as I18nInstance } from "i18next";

import type en from "./locales/en.json";
import { BUNDLED } from "./bundled-locales";

import { DEFAULT_LANGUAGE, LANGUAGES, languageFor, type LanguageCode } from "./languages";

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
 * ## Why resources are in memory rather than loaded per request
 *
 * There is no network hop, so `getFixedT` is usable synchronously and a page
 * never flashes English on first paint. The server holds all ten languages.
 * The browser starts with English and receives the merchant's language in the
 * shell loader's data, registered with `registerLanguage` before the first
 * render, so it never downloads the other eight.
 */

const RESOURCES: Record<string, { translation: Record<string, unknown> }> = { ...BUNDLED };

/** Adds a language's strings, as sent by the shell loader. */
export function registerLanguage(language: LanguageCode, translation: Record<string, unknown>): void {
  if (!RESOURCES[language]) RESOURCES[language] = { translation };
}

/** The strings for a language, when this process holds them. */
export function languageStrings(language: LanguageCode): Record<string, unknown> | null {
  return RESOURCES[language]?.translation ?? null;
}

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
    supportedLngs: LANGUAGES.map((language) => language.code),
    ns: ["translation"],
    defaultNS: "translation",
    // Without this the instance has no translations at all and every `t()` call
    // returns its own key as a string, so the admin renders `nav.dashboard`
    // rather than "Dashboard". Bundled, so there is no async load to await and
    // `getFixedT` below is usable synchronously.
    resources: RESOURCES,
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
export function intlLocaleFor(language: LanguageCode, regional?: string | null): string {
  const base = languageFor(language).intlLocale;
  const preferred = regionalLocale(language, regional);
  return preferred ?? base;
}

/**
 * A regional variant of the admin language for dates and numbers, when the
 * merchant's own locale names one: an English-speaking merchant in the UK gets
 * day/month order and a Swiss German merchant Swiss separators, while the words
 * stay in the admin language. Null when `regional` is not a region of the same
 * language (a French browser never changes an English admin's formats).
 */
export function regionalLocale(language: LanguageCode, regional: string | null | undefined): string | null {
  if (!regional) return null;
  let canonical: string | undefined;
  try {
    [canonical] = Intl.getCanonicalLocales(regional.trim().replace(/_/g, "-"));
  } catch {
    return null;
  }
  if (!canonical || !canonical.includes("-")) return null;
  const base = languageFor(language).intlLocale.split("-")[0]!.toLowerCase();
  return canonical.split("-")[0]!.toLowerCase() === base ? canonical : null;
}

export {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  languageFor,
  resolveLanguage,
  LANGUAGES,
} from "./languages";
export type { LanguageCode, Language } from "./languages";
export { RESOURCES };
