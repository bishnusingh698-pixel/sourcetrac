import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isShopifyConfirmationUrl } from "../../app/lib/billing-redirect";

describe("isShopifyConfirmationUrl", () => {
  it("accepts Shopify's approval pages", () => {
    expect(isShopifyConfirmationUrl("https://admin.shopify.com/store/demo/charges/123/confirm_recurring_application_charge?signature=x")).toBe(true);
    expect(isShopifyConfirmationUrl("https://demo.myshopify.com/admin/charges/123/confirm_recurring_application_charge")).toBe(true);
  });

  it("refuses anything that could send the merchant elsewhere", () => {
    for (const url of [
      undefined,
      null,
      "",
      "not a url",
      "http://admin.shopify.com/store/demo",
      "https://evil.com/admin.shopify.com",
      "https://myshopify.com.evil.com/",
      "https://admin.shopify.com.evil.com/",
      "https://user:pass@admin.shopify.com/",
      "https://admin.shopify.com:8443/",
      "javascript:alert(1)",
    ]) {
      expect(isShopifyConfirmationUrl(url), String(url)).toBe(false);
    }
  });
});

// The library's redirect answers the page's fetch with a 401 and a reauthorize
// header; through React Router that 401 reached the error screen.
describe("Plans page opens the approval page itself", () => {
  const source = readFileSync(fileURLToPath(new URL("../../app/routes/app.plans.tsx", import.meta.url)), "utf8");
  it("does not redirect from the action", () => {
    expect(source).not.toMatch(/redirect\(\s*created\.confirmationUrl/);
  });
  it("opens the URL in the top frame", () => {
    expect(source).toContain('window.open(confirmationUrl, "_top")');
  });
});
