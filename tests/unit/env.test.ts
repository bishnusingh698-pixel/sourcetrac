import { describe, expect, it } from "vitest";

import { parseEnv } from "~/lib/env";

const base = {
  DATABASE_URL: "postgresql://x/y",
  SHOPIFY_API_KEY: "k",
  SHOPIFY_API_SECRET: "s",
  SHOPIFY_API_VERSION: "2026-07",
  SCOPES: "read_orders",
  APP_URL: "https://example.test",
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
};

describe("parseEnv", () => {
  it("treats an empty optional variable as unset, as .env.example ships it", () => {
    // `RETENTION_JOB_SECRET=` used to fail min(16) and stop the app booting.
    const parsed = parseEnv({ ...base, RETENTION_JOB_SECRET: "", SUPPORT_EMAIL: "", LOG_LEVEL: "" });
    expect(parsed.RETENTION_JOB_SECRET).toBeUndefined();
    expect(parsed.SUPPORT_EMAIL).toBeUndefined();
    expect(parsed.LOG_LEVEL).toBeUndefined();
  });

  it("still rejects a set but too-short retention secret", () => {
    expect(() => parseEnv({ ...base, RETENTION_JOB_SECRET: "short" })).toThrow(/RETENTION_JOB_SECRET/);
  });

  it("falls back to the CLI's SHOPIFY_APP_URL", () => {
    expect(parseEnv({ ...base, APP_URL: "", SHOPIFY_APP_URL: "https://tunnel.test" }).APP_URL).toBe("https://tunnel.test");
  });
});
