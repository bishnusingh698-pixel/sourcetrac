import { z } from "zod";

/**
 * Environment validation. Fails fast at boot rather than at first request, so
 * a missing secret is a deploy-time error, not a 3am incident.
 */

/**
 * The Admin API version this code is written and tested against. It must equal
 * `shopify.app.toml` `[webhooks] api_version` and every extension's
 * `api_version` (tests/unit/api-version.test.ts checks them). A deploy cannot
 * point the admin calls at a different schema through the environment.
 */
export const API_VERSION = "2026-07";

/** The scopes `shopify.app.toml` declares under [access_scopes]. */
export const DECLARED_SCOPES = ["read_orders", "write_orders", "write_customers", "read_products"] as const;

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
  SHOPIFY_API_VERSION: optional(
    z.literal(API_VERSION, { errorMap: () => ({ message: `Must be ${API_VERSION}, the version the app is built for.` }) }),
  ).transform((value) => value ?? API_VERSION),
  SCOPES: z.string().min(1, "Required."),
  APP_URL: z.string().url("Must be an absolute URL."),
  TOKEN_ENCRYPTION_KEY: HEX_32,
  /**
   * The previous key while rotating: tokens sealed with it still decrypt, and
   * are re-sealed with the current key when next stored. Remove once rotated.
   */
  TOKEN_ENCRYPTION_KEY_PREVIOUS: optional(HEX_32),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: optional(z.enum(["debug", "info", "warn", "error"])),
  /**
   * Deprecated and ignored. The support email is the `SUPPORT_EMAIL` constant in
   * `shared/support.ts`, not configuration: it is the only address the app may
   * contain, and the email-scan test enforces that. Kept optional so an existing
   * deployment that still sets it does not fail the boot check.
   */
  SUPPORT_EMAIL: optional(z.string().email()),
  /**
   * Shared secret for POST /jobs/retention. Optional at boot so a developer can
   * run the app without it, but the route fails closed without it -- it never
   * runs an unauthenticated delete.
   */
  RETENTION_JOB_SECRET: optional(z.string().min(16, "Must be at least 16 characters.")),
  /**
   * Secret for GET /readyz, so an uptime monitor does not need the secret that
   * authorises the data-deleting retention job. Falls back to
   * RETENTION_JOB_SECRET when unset.
   */
  READYZ_SECRET: optional(z.string().min(16, "Must be at least 16 characters.")),
  /**
   * "off" stops the server pinging its own /healthz (see keep-awake.server.ts).
   * On by default in production.
   */
  KEEP_AWAKE: optional(z.enum(["on", "off"])),
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
  const allowed = new Set<string>(DECLARED_SCOPES);
  const extra = scopes.filter((s) => !allowed.has(s));
  if (extra.length > 0) {
    warnings.push(
      `SCOPES contains ${extra.join(", ")} which SourceTrac does not use. ` +
        `Requesting extra scopes risks App Store rejection under requirement 3.2.`,
    );
  }
  // SCOPES must say what shopify.app.toml declares; otherwise the scopes the
  // library asks for at auth differ from the installed app's configuration.
  const missing = DECLARED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    warnings.push(`SCOPES is missing ${missing.join(", ")}, which shopify.app.toml declares. Keep them identical.`);
  }

  if (e.TOKEN_ENCRYPTION_KEY === "0".repeat(64)) {
    warnings.push("TOKEN_ENCRYPTION_KEY is the all-zero placeholder. Generate a real key before deploying.");
  }

  return warnings;
}
