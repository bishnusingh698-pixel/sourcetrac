import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "./env";

/**
 * AES-256-GCM encryption for Shopify offline access tokens.
 *
 * Level 1 protected-customer-data requirement 9: "Encrypt data at rest".
 * GCM gives us confidentiality plus an auth tag, so a tampered ciphertext
 * fails to decrypt rather than silently yielding garbage.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits — the GCM-recommended size
const TAG_LENGTH = 16;

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  tag: string;
};

function key(): Buffer {
  return Buffer.from(env().TOKEN_ENCRYPTION_KEY, "hex");
}

export function encryptSecret(plaintext: string): EncryptedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Returns null on any failure. A token we cannot decrypt is treated as absent
 * rather than fatal: the merchant re-installs or re-auths instead of the app
 * crash-looping on a corrupt row.
 */
export function decryptSecret(value: EncryptedValue | null | undefined): string | null {
  if (!value?.ciphertext || !value.iv || !value.tag) return null;

  try {
    const iv = Buffer.from(value.iv, "base64");
    const tag = Buffer.from(value.tag, "base64");
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return null;

    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison. Used for HMAC verification, where a
 * timing side-channel would let an attacker forge a signature byte by byte.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  // The early return leaks length only, which is not secret for an HMAC.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe random token, used for jti replay tracking and nonces. */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}
