import { z } from "zod";

/**
 * Environment validation. Fails fast at boot rather than at first request, so
 * a missing secret is a deploy-time error, not a 3am incident.
 */

const HEX_32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "Must be a 32-byte hex string. Generate with: openssl rand -hex 32");

/**
 * An optional variable set to "" counts as unset. The Shopify CLI and Render
 * both pass `NAME=` through as an empty string, and `.env.example` ships
 * `RETENTION_JOB_SECRET=`: copied as-is, `min(16)` rejected "" and the app
 * refused to boot.
 */
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner.optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1, "Required."),
  SHOPIFY_API_KEY: z.string().min(1, "Required."),
  SHOPIFY_API_SECRET: z.string().min(1, "Required."),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/, "Must look like 2026-07."),
  SCOPES: z.string().min(1, "Required."),
  APP_URL: z.string().url("Must be an absolute URL."),
  TOKEN_ENCRYPTION_KEY: HEX_32,
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: optional(z.enum(["debug", "info", "warn", "error"])),
  SUPPORT_EMAIL: optional(z.string().email()),
  /**
   * Shared secret for POST /jobs/retention. Optional at boot so a developer can
   * run the app without it, but the route fails closed without it -- it never
   * runs an unauthenticated delete.
   */
  RETENTION_JOB_SECRET: optional(z.string().min(16, "Must be at least 16 characters.")),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  cached = parseEnv(process.env);
  return cached;
}

/** Validate an environment. Exported so the rules can be tested without `process.env`. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // `shopify app dev` exports its tunnel URL as SHOPIFY_APP_URL, not APP_URL,
  // and the tunnel changes per run, so a hand-copied APP_URL goes stale and
  // breaks auth. Fall back to the CLI's value when APP_URL is unset.
  const parsed = schema.safeParse({
    ...source,
    APP_URL: source.APP_URL || source.SHOPIFY_APP_URL,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${detail}`);
  }

  return parsed.data;
}

/**
 * Boot-time assertions. These catch configuration drift between
 * shopify.app.toml, the extensions, and the backend — the class of bug that
 * otherwise only shows up as a survey that silently never appears.
 */
export function assertStartupInvariants(): string[] {
  const warnings: string[] = [];
  const e = env();

  if (!e.APP_URL.startsWith("https://") && e.NODE_ENV === "production") {
    warnings.push("APP_URL is not HTTPS. Shopify requires TLS for embedded apps and webhooks.");
  }

  const scopes = e.SCOPES.split(",").map((s) => s.trim()).filter(Boolean);
  // The deliberate allowlist. Phase 7 adds write scopes for order/customer tags
  // and product collection targeting; each such feature is gated at runtime on
  // the *granted* scopes (see app/lib/scopes.server.ts), so a store that has not
  // re-approved keeps working. Anything outside this set is a mistake.
  const allowed = new Set(["read_orders", "write_orders", "write_customers", "read_products"]);
  const extra = scopes.filter((s) => !allowed.has(s));
  if (extra.length > 0) {
    warnings.push(
      `SCOPES contains ${extra.join(", ")} which SourceTrac does not use. ` +
        `Requesting extra scopes risks App Store rejection under requirement 3.2.`,
    );
  }

  if (e.TOKEN_ENCRYPTION_KEY === "0".repeat(64)) {
    warnings.push("TOKEN_ENCRYPTION_KEY is the all-zero placeholder. Generate a real key before deploying.");
  }

  return warnings;
}
