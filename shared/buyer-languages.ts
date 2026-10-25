/**
 * Languages a merchant can translate a survey into, for buyers.
 *
 * Wider than the admin's ten: a store selling to Arabic, Hebrew, Korean or
 * Polish speakers needs its survey in their language even though the admin
 * itself is not translated into it. The checkout block picks the translation
 * that matches the buyer's checkout language (`matchLocale`), falling back
 * field by field to the survey's own wording, and ships its own buttons
 * ("Submit", "Other") in every language listed here.
 *
 * `rtl` languages are laid out right to left by Shopify's checkout itself; the
 * block uses logical (start/end) layout only, so it mirrors with no extra code.
 *
 * To add a language: add it here, and add `<code>.json` to both checkout
 * extensions' `locales/` (tests/unit/extension-i18n.test.ts checks both).
 */
export type BuyerLanguage = { code: string; name: string; rtl?: boolean };

export const BUYER_LANGUAGES: readonly BuyerLanguage[] = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "zh-CN", name: "简体中文" },
  { code: "ja", name: "日本語" },
  { code: "it", name: "Italiano" },
  { code: "nl", name: "Nederlands" },
  { code: "sv", name: "Svenska" },
  { code: "ar", name: "العربية", rtl: true },
  { code: "he", name: "עברית", rtl: true },
  { code: "ko", name: "한국어" },
  { code: "pl", name: "Polski" },
  { code: "tr", name: "Türkçe" },
  { code: "da", name: "Dansk" },
  { code: "fi", name: "Suomi" },
  { code: "nb", name: "Norsk bokmål" },
];

export function isRtlLanguage(code: string): boolean {
  return BUYER_LANGUAGES.some((language) => language.code === code && language.rtl === true);
}
