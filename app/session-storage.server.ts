import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import { db } from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { logger } from "~/lib/logger";

/**
 * Session storage for the embedded admin.
 *
 * Uses the Shopify-maintained Prisma adapter so offline tokens survive a
 * restart, wrapped so the tokens it writes are encrypted at rest.
 *
 * The adapter stores `accessToken` and `refreshToken` as plain text. The copy in
 * `Shop` was AES-256-GCM encrypted, but the same live Admin API token sat in
 * clear in `Session`, so anyone with read access to the database (a leaked
 * DATABASE_URL, a Neon branch, a backup) held working tokens for every store.
 *
 * Rows written before this change are still plain text; they are read as-is
 * and encrypted on the next store, so no migration is needed.
 */
const PREFIX = "enc:v1:";

export function sealToken(value: string | undefined): string | undefined {
  if (!value || value.startsWith(PREFIX)) return value;
  const { iv, tag, ciphertext } = encryptSecret(value);
  return `${PREFIX}${iv}:${tag}:${ciphertext}`;
}

export function openToken(value: string | undefined): string | undefined {
  if (!value?.startsWith(PREFIX)) return value;
  const [iv = "", tag = "", ciphertext = ""] = value.slice(PREFIX.length).split(":");
  const plain = decryptSecret({ iv, tag, ciphertext });
  if (plain === null) {
    // Wrong key or a corrupt row. Treated as no token, so the library re-runs
    // token exchange instead of calling Shopify with garbage.
    logger.warn("session_token_undecryptable", {});
    return undefined;
  }
  return plain;
}

function mapTokens(session: Session, map: (value: string | undefined) => string | undefined): Session {
  const copy = new Session(session.toObject());
  copy.accessToken = map(session.accessToken);
  copy.refreshToken = map(session.refreshToken);
  return copy;
}

class EncryptedSessionStorage {
  constructor(private readonly inner: PrismaSessionStorage<never>) {}

  storeSession(session: Session): Promise<boolean> {
    return this.inner.storeSession(mapTokens(session, sealToken));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    return session ? mapTokens(session, openToken) : undefined;
  }

  deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return (await this.inner.findSessionsByShop(shop)).map((session) => mapTokens(session, openToken));
  }

  isReady(): Promise<boolean> {
    return this.inner.isReady();
  }
}

export const sessionStorage = new EncryptedSessionStorage(new PrismaSessionStorage(db as never));
