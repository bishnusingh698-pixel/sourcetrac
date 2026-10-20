import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

/** Keys to try when decrypting: the current one, then the one being rotated out. */
function decryptionKeys(): Buffer[] {
  const previous = env().TOKEN_ENCRYPTION_KEY_PREVIOUS;
  return previous ? [key(), Buffer.from(previous, "hex")] : [key()];
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
  return decryptSecretWithKey(value)?.plaintext ?? null;
}

/**
 * `decryptSecret`, also saying whether the key being rotated out was needed,
 * so the caller can re-seal the value with the current key before that key is
 * removed.
 */
export function decryptSecretWithKey(
  value: EncryptedValue | null | undefined,
): { plaintext: string; usedPreviousKey: boolean } | null {
  if (!value?.ciphertext || !value.iv || !value.tag) return null;

  const iv = Buffer.from(value.iv, "base64");
  const tag = Buffer.from(value.tag, "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return null;

  // GCM authenticates, so a wrong key fails cleanly and the next one is tried.
  const keys = decryptionKeys();
  for (let index = 0; index < keys.length; index += 1) {
    try {
      const decipher = createDecipheriv(ALGORITHM, keys[index]!, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, "base64")),
        decipher.final(),
      ]);
      return { plaintext: plaintext.toString("utf8"), usedPreviousKey: index > 0 };
    } catch {
      // Try the next key.
    }
  }
  return null;
}

/**
 * Constant-time string comparison. Used for HMAC verification, where a
 * timing side-channel would let an attacker forge a signature byte by byte.
 */
export function safeEqual(a: string, b: string): boolean {
  // Compare fixed-length digests: comparing the raw strings needs an early
  // length check, which leaks the length of a secret it is compared against.
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/** URL-safe random token, used for jti replay tracking and nonces. */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}
