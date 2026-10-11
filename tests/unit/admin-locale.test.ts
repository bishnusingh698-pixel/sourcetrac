import { describe, expect, it } from "vitest";

import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";

const request = (url: string) => new Request(url, { headers: { "accept-language": "en-US,en;q=0.9" } });

describe("admin language across navigations", () => {
  it("keeps the Shopify admin's locale after a navigation drops ?locale=", () => {
    // First document load: Shopify passes the admin's locale.
    expect(resolveAdminLanguage(request("https://a.test/app?locale=de"), null)).toBe("de");
    // Client navigation: no ?locale=, browser says English. The remembered
    // admin locale must win, or the app flips to English on the first click.
    expect(resolveAdminLanguage(request("https://a.test/app/settings"), null, "de")).toBe("de");
  });

  it("still lets the merchant's own saved choice win", () => {
    expect(resolveAdminLanguage(request("https://a.test/app/settings"), "fr", "de")).toBe("fr");
  });
});
