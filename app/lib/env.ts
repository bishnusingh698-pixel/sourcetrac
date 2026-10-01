import { z } from "zod";

/**
 * Environment validation. Fails fast at boot rather than at first request, so
 * a missing secret is a deploy-time error, not a 3am incident.
 */

const HEX_32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "Must be a 32-byte hex string. Generate with: openssl rand -hex 32");

const schema = z.object({
  DATABASE_URL: z.string().min(1, "Required."),
  SHOPIFY_API_KEY: z.string().min(1, "Required."),
  SHOPIFY_API_SECRET: z.string().min(1, "Required."),
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/, "Must look like 2026-07."),
  SCOPES: z.string().min(1, "Required."),
  APP_URL: z.string().url("Must be an absolute URL."),
  TOKEN_ENCRYPTION_KEY: HEX_32,
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${detail}`);
  }

  cached = parsed.data;
  return cached;
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
  const allowed = new Set(["read_orders"]);
  const extra = scopes.filter((s) => !allowed.has(s));
  if (extra.length > 0) {
    warnings.push(
      `SCOPES contains ${extra.join(", ")} but SourceTrac only needs read_orders. ` +
        `Requesting extra scopes risks App Store rejection under requirement 3.2.`,
    );
  }

  if (e.TOKEN_ENCRYPTION_KEY === "0".repeat(64)) {
    warnings.push("TOKEN_ENCRYPTION_KEY is the all-zero placeholder. Generate a real key before deploying.");
  }

  return warnings;
}
