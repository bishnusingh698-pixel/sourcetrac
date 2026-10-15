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
 * and sealed on that first read (a non-expiring offline session is never
 * stored again, so waiting for the next store left it plain forever).
 */
const PREFIX = "enc:v1:";

export function sealToken(value: string | undefined): string | undefined {
  if (!value || value.startsWith(PREFIX)) return value;
  const { iv, tag, ciphertext } = encryptSecret(value);
  return `${PREFIX}${iv}:${tag}:${ciphertext}`;
}

export function openToken(value: string | undefined, context: { sessionId?: string; shop?: string } = {}): string | undefined {
  if (!value?.startsWith(PREFIX)) return value;
  const [iv = "", tag = "", ciphertext = ""] = value.slice(PREFIX.length).split(":");
  const plain = decryptSecret({ iv, tag, ciphertext });
  if (plain === null) {
    // Wrong key or a corrupt row. Treated as no token, so the library re-runs
    // token exchange instead of calling Shopify with garbage. Logged with the
    // session and shop: after a key rotation this is the line to look for.
    logger.warn("session_token_undecryptable", { session_id: context.sessionId, shop_domain: context.shop });
    return undefined;
  }
  return plain;
}

/** Whether a stored row still holds a token in plain text. */
function hasPlainToken(session: Session): boolean {
  return Boolean(
    (session.accessToken && !session.accessToken.startsWith(PREFIX)) ||
      (session.refreshToken && !session.refreshToken.startsWith(PREFIX)),
  );
}

function mapTokens(session: Session, map: (value: string | undefined) => string | undefined): Session {
  const copy = new Session(session.toObject());
  copy.accessToken = map(session.accessToken);
  copy.refreshToken = map(session.refreshToken);
  return copy;
}

class EncryptedSessionStorage {
  private current: PrismaSessionStorage<never> | null = null;

  constructor(private readonly create: () => PrismaSessionStorage<never>) {}

  /**
   * The adapter checks for its table once, when constructed, and keeps a
   * failed check forever: a database that was briefly unreachable at boot
   * (Neon waking) left every session call throwing until a restart, and the
   * rejection itself was unhandled. Built on first use and rebuilt after a
   * failed check, so the next request tries again.
   */
  private inner(): PrismaSessionStorage<never> {
    if (this.current) return this.current;
    const created = this.create();
    this.current = created;
    (created as unknown as { ready: Promise<unknown> }).ready.catch((error: unknown) => {
      if (this.current === created) this.current = null;
      logger.warn("session_storage_not_ready", {
        error_message: error instanceof Error ? error.message : String(error),
      });
    });
    return created;
  }

  storeSession(session: Session): Promise<boolean> {
    return this.inner().storeSession(mapTokens(session, sealToken));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner().loadSession(id);
    if (!session) return undefined;
    if (hasPlainToken(session)) {
      // Seal a legacy plain-text row now; failing to is logged, not fatal.
      await this.inner()
        .storeSession(mapTokens(session, sealToken))
        .catch((error: unknown) => {
          logger.warn("session_token_reseal_failed", {
            session_id: id,
            error_message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return mapTokens(session, (value) => openToken(value, { sessionId: id, shop: session.shop }));
  }

  deleteSession(id: string): Promise<boolean> {
    return this.inner().deleteSession(id);
  }

  deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner().deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return (await this.inner().findSessionsByShop(shop)).map((session) =>
      mapTokens(session, (value) => openToken(value, { sessionId: session.id, shop })),
    );
  }

  isReady(): Promise<boolean> {
    return this.inner().isReady();
  }
}

export const sessionStorage = new EncryptedSessionStorage(() => new PrismaSessionStorage(db as never));
