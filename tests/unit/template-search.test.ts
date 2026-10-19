import { describe, expect, it } from "vitest";

import { TEMPLATES } from "@shared/templates";
import { templateText } from "@shared/templates/locales";
import { matchesSearch, normalizeSearchText, searchTerms } from "@shared/templates/search";

/** What the library sends for a card: name, one-liner, questions and aliases. */
function haystack(id: string, locale: string): string {
  const t = TEMPLATES.find((x) => x.id === id)!;
  return normalizeSearchText(
    [
      templateText(locale, t.nameKey),
      templateText(locale, t.oneLinerKey),
      ...t.questions.map((q) => templateText(locale, q.textKey)),
      ...(t.searchAliases ?? []),
    ].join(" "),
  );
}

const find = (query: string, locale = "en") =>
  TEMPLATES.filter((t) => matchesSearch(haystack(t.id, locale), searchTerms(query))).map((t) => t.id);

describe("template search", () => {
  it("finds templates by the jargon merchants type", () => {
    expect(find("NPS")).toContain("loyalty-pulse");
    expect(find("csat")).toContain("customer-satisfaction");
    expect(find("attribution")).toContain("channel-compass");
    expect(find("discount")).toContain("offer-impact");
    expect(find("amazon")).toEqual(["where-else", "search-terms"]);
  });

  it("needs every word, matches word starts, and ignores case and accents", () => {
    expect(find("subscri")).toContain("subscribe-interest");
    expect(find("gift occasion")).toContain("gift-radar");
    expect(find("gift amazon")).toEqual([]);
    // "ver" is inside "delivery" but starts no word there.
    expect(find("ver").includes("delivery-promise")).toBe(false);
    expect(find("enquête", "fr").length).toBeLessThanOrEqual(find("enquete", "fr").length);
  });

  it("searches in the admin language, including scripts without spaces", () => {
    expect(find("Geschenk", "de")).toContain("gift-radar");
    expect(find("ギフト", "ja")).toContain("gift-radar");
  });

  it("shows everything for an empty query", () => {
    expect(find("   ")).toHaveLength(TEMPLATES.length);
  });
});
