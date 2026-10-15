import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { API_VERSION, DECLARED_SCOPES, parseEnv } from "~/lib/env";

/**
 * The Admin API version is pinned in code (S1-2). The app config, every
 * extension and the code must name the same version, and a deploy cannot point
 * the admin calls elsewhere through SHOPIFY_API_VERSION.
 */
const root = join(import.meta.dirname, "..", "..");

const base = {
  DATABASE_URL: "postgresql://x",
  SHOPIFY_API_KEY: "k",
  SHOPIFY_API_SECRET: "s",
  SCOPES: DECLARED_SCOPES.join(","),
  APP_URL: "https://example.com",
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
};

describe("pinned Admin API version", () => {
  it("matches shopify.app.toml and every extension", () => {
    const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
    expect(toml).toContain(`api_version = "${API_VERSION}"`);
    expect(toml).not.toMatch(/scopes_api_version/);
    for (const dir of readdirSync(join(root, "extensions"))) {
      const path = join(root, "extensions", dir, "shopify.extension.toml");
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      expect(text, dir).toContain(`api_version = "${API_VERSION}"`);
    }
  });

  it("declares the same scopes as shopify.app.toml", () => {
    const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");
    expect(toml).toContain(`scopes = "${DECLARED_SCOPES.join(",")}"`);
  });

  it("defaults to the pinned version and refuses any other", () => {
    expect(parseEnv(base).SHOPIFY_API_VERSION).toBe(API_VERSION);
    expect(parseEnv({ ...base, SHOPIFY_API_VERSION: API_VERSION }).SHOPIFY_API_VERSION).toBe(API_VERSION);
    expect(() => parseEnv({ ...base, SHOPIFY_API_VERSION: "2025-07" })).toThrow(/SHOPIFY_API_VERSION/);
  });
});
