import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the App Bridge wiring.
 *
 * App Bridge is what actually renders this app into the Shopify admin iframe.
 * When it is missing, every loader still succeeds, every health check still
 * passes, and the merchant still sees a blank panel. Nothing at runtime catches
 * it, so the absence is asserted here against the source.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

describe("embedded admin app bridge", () => {
  it("wraps the admin shell in AppProvider", () => {
    const shell = read("app/routes/app.tsx");

    expect(shell).toMatch(/import\s+\{\s*AppProvider\s*\}/);
    // The provider must actually render, not merely be imported.
    expect(shell).toMatch(/<AppProvider\s+apiKey=/);
    expect(shell).toContain("</AppProvider>");
  });

  it("passes the public client id to AppProvider", () => {
    const shell = read("app/routes/app.tsx");

    // The loader must hand the key to the component. Hardcoding an empty string
    // in the layout would render an uninitialised App Bridge: the shell appears
    // and then silently does nothing.
    expect(shell).toMatch(/apiKey:\s*process\.env\.SHOPIFY_API_KEY/);
  });

  it("does not load the polaris script twice", () => {
    const root = read("app/root.tsx");

    // AppProvider injects the Polaris web-components script itself. A second
    // hand-written tag in the document head loads the bundle twice.
    expect(root).not.toContain("polaris.js");
  });

  it("prebundles only packages that are actually installed", () => {
    const vite = read("vite.config.ts");
    const prebundled = [...vite.matchAll(/optimizeDeps\s*:\s*\{[^}]*\}/g)].map((m) => m[0]);

    // optimizeDeps.include is a hard require at dev-server start. Naming a
    // package that is not installed fails to resolve and takes the server down.
    for (const block of prebundled) {
      const packages = [...block.matchAll(/["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined)
        .filter((name) => name.startsWith("@") || name.startsWith("."));
      for (const name of packages) {
        expect(() => require.resolve(name), `${name} is prebundled but not installed`).not.toThrow();
      }
    }
  });
});
