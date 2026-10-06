import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isShopifyAuthResponse } from "../../app/lib/shopify-boundary";

/**
 * Guards the path by which the admin actually appears.
 *
 * Shopify's auth library throws a 200 HTML page (App Bridge) whenever a request
 * reaches the app without `host`: the billing return, a bookmarked URL, a
 * first open after install. The admin shell's ErrorBoundary used to render that
 * as a failure, so the merchant saw "200 Go to the dashboard" and never reached
 * the dashboard or the survey editor.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

/** The shape React Router gives a thrown Response inside an ErrorBoundary. */
const routeError = (status: number, data: unknown) => ({ status, statusText: "", internal: false, data });

describe("Shopify auth responses in error boundaries", () => {
  it("treats a thrown 2xx App Bridge page as an auth response", () => {
    expect(isShopifyAuthResponse(routeError(200, '<script src="app-bridge.js"></script>'))).toBe(true);
  });

  it("still treats real failures as errors", () => {
    expect(isShopifyAuthResponse(routeError(500, { reference: "x", hint: "y" }))).toBe(false);
    expect(isShopifyAuthResponse(routeError(404, "Not Found"))).toBe(false);
    expect(isShopifyAuthResponse(new Error("boom"))).toBe(false);
    expect(isShopifyAuthResponse(null)).toBe(false);
  });

  it("renders auth responses with the library boundary in both error boundaries", () => {
    for (const file of ["app/routes/app.tsx", "app/root.tsx"]) {
      const source = read(file);
      expect(source, file).toMatch(/if \(isShopifyAuthResponse\(error\)\)/);
      expect(source, file).toContain("boundary.error(error)");
    }
  });

  it("registers the admin sidebar navigation with App Bridge", () => {
    const shell = read("app/routes/app.tsx");
    expect(shell).toContain("<s-app-nav>");
    expect(shell).toMatch(/<s-link key=\{item\.to\} href=\{item\.to\}>/);
  });
});

describe("billing return URL", () => {
  it("returns the merchant into the embedded admin, not a bare app URL", async () => {
    Object.assign(process.env, {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://x@localhost/x_test",
      SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY ?? "client-id",
      SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET ?? "secret",
      SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION ?? "2026-07",
      SCOPES: process.env.SCOPES ?? "read_orders",
      APP_URL: process.env.APP_URL ?? "https://sourcetrac.example",
      TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY ?? "0".repeat(64),
    });
    const { billingReturnUrl } = await import("../../app/lib/billing.server");
    const key = encodeURIComponent(process.env.SHOPIFY_API_KEY ?? "");

    expect(billingReturnUrl("my-store.myshopify.com")).toBe(
      `https://admin.shopify.com/store/my-store/apps/${key}/app/plans?billing=return`,
    );
  });
});
