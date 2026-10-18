import en from "./locales/en.json";

/**
 * The browser's built-in strings: English only, the fallback for every key.
 * The merchant's own language arrives in the shell loader's data. See
 * `bundled-locales.ts`.
 */
export const BUNDLED: Record<string, { translation: Record<string, unknown> }> = {
  en: { translation: en },
};
