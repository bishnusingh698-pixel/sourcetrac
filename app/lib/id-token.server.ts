import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "~/lib/env";

/**
 * Verification of Shopify OpenID Connect ID tokens (Phase 7).
 *
 * Admin UI extensions fetch our own backend with `auth.idToken()`, which the
 * host injects as `Authorization: Bearer <jwt>`. Per Shopify's docs the token is
 * HS256-signed with the app's client secret, so we verify the signature the same
 * way `@shopify/shopify-api` decodes a session token — HMAC over the raw signing
 * input, with the secret used as raw bytes.
 *
 * Hand-rolled rather than pulled from `@shopify/shopify-api`'s exported decoder
 * because that decoder is not part of the package's public surface. It is a
 * small, self-contained HS256 check: signature, then `aud`/`exp`/`nbf`, then the
 * caller decides which claim identifies the shop. Nothing from the body is
 * trusted before the signature holds.
 */

export type IdTokenClaims = {
  /** Shop domain, e.g. `store.myshopify.com`, with no scheme. */
  dest: string;
  /** App client id; must equal ours. */
  aud: string;
  sub?: string;
  exp?: number;
  nbf?: number;
};

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdTokenError";
  }
}

const JWT_CLOCK_TOLERANCE_SECONDS = 10;

function hmacKey(): Buffer {
  return Buffer.from(env().SHOPIFY_API_SECRET, "utf8");
}

/** Verify an HS256 JWT signed with the app secret. Returns claims or throws. */
export function verifyIdToken(token: string): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdTokenError("Malformed token");

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = parsePart(headerB64);
  if (header.alg !== "HS256") throw new IdTokenError("Unexpected signing algorithm");

  // Compared as base64url text, not decoded bytes: Node's base64 decoder skips
  // characters it does not know, so many different strings decoded to the
  // same signature.
  const expected = Buffer.from(createHmac("sha256", hmacKey()).update(`${headerB64}.${payloadB64}`).digest("base64url"));
  const provided = Buffer.from(signatureB64.replace(/=+$/, ""));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new IdTokenError("Signature does not match");
  }

  const claims = parsePart(payloadB64) as Record<string, unknown>;

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  const nbf = typeof claims.nbf === "number" ? claims.nbf : undefined;
  // Every Shopify token carries `exp`; one without it would never expire.
  if (exp === undefined) throw new IdTokenError("Token has no expiry");
  if (exp < now - JWT_CLOCK_TOLERANCE_SECONDS) throw new IdTokenError("Token expired");
  if (nbf !== undefined && nbf > now + JWT_CLOCK_TOLERANCE_SECONDS) throw new IdTokenError("Token not yet valid");

  const aud = typeof claims.aud === "string" ? claims.aud : "";
  if (aud !== env().SHOPIFY_API_KEY) throw new IdTokenError("Audience does not match the app");

  const dest = (typeof claims.dest === "string" ? claims.dest : "").replace(/^https?:\/\//, "").toLowerCase();
  if (!dest) throw new IdTokenError("Token has no shop claim");

  // Only an ADMIN token, issued for this shop's admin. Checkout and customer
  // account session tokens are signed with the same secret and carry the same
  // `aud`, so without this a buyer could read any order's answers.
  const iss = (typeof claims.iss === "string" ? claims.iss : "").toLowerCase();
  if (iss !== `https://${dest}/admin`) throw new IdTokenError("Token was not issued by the shop admin");

  return {
    dest,
    aud,
    sub: typeof claims.sub === "string" ? claims.sub : undefined,
    exp,
    nbf,
  };
}

function parsePart(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    throw new IdTokenError("Token part is not valid JSON");
  }
  // `null`, a number or an array is valid JSON but not a header or claims set;
  // reading a field off it threw a TypeError (a 500) instead of a 401.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdTokenError("Token part is not a JSON object");
  }
  return value as Record<string, unknown>;
}
