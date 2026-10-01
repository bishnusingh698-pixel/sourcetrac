import { DEFAULT_LANGUAGE, resolveLanguage, type LanguageCode } from "./languages";

/**
 * Which language to render a request in.
 *
 * Precedence, highest first:
 *
 *   1. `?lng=` in the URL. An explicit click on the language picker, so it must
 *      beat both stored and detected values, otherwise switching language would
 *      appear to do nothing on a store whose saved value differs.
 *   2. The merchant's saved choice in the database. This is the durable override
 *      and always beats detection from then on.
 *   3. Shopify's `locale` query parameter. Shopify appends this to GET requests
 *      into the admin with the app user's chosen locale.
 *   4. `Accept-Language`, so a merchant whose admin sends a different header than
 *      the query param still gets something sensible.
 *   5. English.
 *
 * The database value is passed in rather than read here: resolving it needs a
 * query the caller has usually already made, and reading it here would hide a
 * second round trip inside what looks like a pure helper.
 */
export function resolveRequestLanguage(params: {
  /** `?lng=` from the current URL. Set when the merchant picks a language. */
  requested?: string | null;
  /** The merchant's saved preference, if any. */
  saved?: string | null;
  /** Shopify's `locale` query parameter. */
  shopifyLocale?: string | null;
  /** `Accept-Language` request header. */
  acceptLanguage?: string | null;
}): LanguageCode {
  const { requested, saved, shopifyLocale, acceptLanguage } = params;

  const fromUrl = resolveLanguage(requested);
  if (fromUrl) return fromUrl;

  const fromSaved = resolveLanguage(saved);
  if (fromSaved) return fromSaved;

  const fromShopify = resolveLanguage(shopifyLocale);
  if (fromShopify) return fromShopify;

  // `Accept-Language` is a weighted list: `de-DE,de;q=0.9,en;q=0.8`. Walk it in
  // order and take the first tag we actually support, rather than trusting the
  // first tag blindly.
  const fromHeader = firstSupportedFromAcceptLanguage(acceptLanguage);
  if (fromHeader) return fromHeader;

  return DEFAULT_LANGUAGE;
}

function firstSupportedFromAcceptLanguage(header: string | null | undefined): LanguageCode | null {
  if (!header) return null;

  // Tolerate the malformed header some proxies emit, e.g. `en;q=0.8,`.
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim();
    if (!tag || tag === "*") continue;

    const resolved = resolveLanguage(tag);
    if (resolved) return resolved;
  }

  return null;
}

/** Whether the merchant has explicitly chosen, as opposed to us detecting one. */
export function hasExplicitChoice(saved: string | null | undefined): boolean {
  return resolveLanguage(saved) !== null;
}

/**
 * Build the href that switches language.
 *
 * Only the `lng` parameter is rewritten. Preserving the rest of the query keeps
 * the merchant on the page they were reading and keeps `?range=30` and similar
 * screen state intact.
 */
export function languageSwitchHref(
  requestUrl: string,
  language: LanguageCode,
  options: { returnTo?: string } = {},
): string {
  const url = new URL(requestUrl);
  url.searchParams.set("lng", language);

  if (options.returnTo) {
    url.searchParams.set("returnTo", options.returnTo);
  }

  return `${url.pathname}${url.search}`;
}