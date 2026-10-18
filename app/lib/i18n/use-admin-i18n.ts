import { useMemo } from "react";
import { useRouteLoaderData } from "react-router";

import type { loader as shellLoader } from "~/routes/app";

import {
  createTranslator,
  DEFAULT_LANGUAGE,
  intlLocaleFor,
  registerLanguage,
  type LanguageCode,
  type TFunction,
} from "./index";

/**
 * A translator for the shell's language, registering the strings the shell
 * loader sent first. The browser bundle carries English only; without this a
 * German merchant's admin would render in English.
 */
export function shellTranslator(language: LanguageCode, messages: Record<string, unknown> | null | undefined): TFunction {
  if (messages) registerLanguage(language, messages);
  return createTranslator(language);
}

/**
 * Translator for any page rendered inside the admin shell.
 *
 * The shell loader (`routes/app`) already resolves the language from `?lng=`,
 * the merchant's saved choice, Shopify's `locale` and `Accept-Language`. Child
 * pages read that value rather than resolving it again, so every page on screen
 * is guaranteed to agree with the shell's nav and banners. React Router
 * revalidates the shell after a language change, so pages re-render in the new
 * language with no extra plumbing.
 *
 * Falls back to English when the shell's data is unavailable (an error
 * boundary rendering because the shell loader itself failed).
 */
export function useAdminI18n(): { t: TFunction; language: LanguageCode; locale: string } {
  const shell = useRouteLoaderData<typeof shellLoader>("routes/app");
  const language = shell?.language ?? DEFAULT_LANGUAGE;
  const messages = shell?.messages;
  return useMemo(
    () => ({ t: shellTranslator(language, messages), language, locale: intlLocaleFor(language) }),
    [language, messages],
  );
}

/**
 * A page `<title>` in the shell's language. `meta` runs outside React, so it
 * reads the shell's loader data from `matches` instead of the hook above.
 */
export function adminTitle(
  matches: ReadonlyArray<{ id: string; loaderData?: unknown } | undefined>,
  key: string,
): Array<{ title: string }> {
  const shell = matches.find((match) => match?.id === "routes/app")?.loaderData as
    | { language?: LanguageCode; messages?: Record<string, unknown> | null }
    | undefined;
  const t = shellTranslator(shell?.language ?? DEFAULT_LANGUAGE, shell?.messages);
  return [{ title: `${t(key)} — SourceTrac` }];
}
