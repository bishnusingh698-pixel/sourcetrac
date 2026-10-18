/**
 * Template search for the library page.
 *
 * Runs in the browser on text the loader already sent (name, one-liner, the
 * questions, what the merchant learns, outcome tags, category), so typing never
 * waits on the server. Every word must appear somewhere; accents and case are
 * ignored, so "enquete" finds "enquête" and "NPS" finds "nps".
 *
 * Dependency-free.
 */

/** Lower-case, accents removed, punctuation to spaces. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a query, normalised. An empty query has none. */
export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Whether every term appears in the haystack. Latin words match at a word
 * start ("deliv" finds "delivery", "ver" does not find "delivery"); scripts
 * without spaces between words (Japanese, Chinese) match anywhere.
 */
export function matchesSearch(haystack: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = ` ${haystack}`;
  return terms.every((term) => (/^[\p{Script=Latin}\p{N}]+$/u.test(term) ? text.includes(` ${term}`) : text.includes(term)));
}
