import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import { db } from "~/db.server";
import { decryptSecretWithKey, encryptSecret } from "~/lib/crypto.server";
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

function unseal(value: string) {
  const [iv = "", tag = "", ciphertext = ""] = value.slice(PREFIX.length).split(":");
  return decryptSecretWithKey({ iv, tag, ciphertext });
}

/** Whether a sealed token still needs the key being rotated out. */
function sealedWithPreviousKey(value: string | undefined): boolean {
  return Boolean(value?.startsWith(PREFIX) && unseal(value)?.usedPreviousKey);
}

export function openToken(value: string | undefined, context: { sessionId?: string; shop?: string } = {}): string | undefined {
  if (!value?.startsWith(PREFIX)) return value;
  const plain = unseal(value)?.plaintext ?? null;
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

/** Trades a legacy non-expiring offline session for an expiring one. */
export type LegacyTokenMigrator = (legacy: Session) => Promise<Session>;

/** An offline session with no expiry holds a token Shopify now refuses. */
export function isLegacyOfflineSession(session: Session): boolean {
  return !session.isOnline && !session.expires && Boolean(session.accessToken);
}

/** How long a failed legacy-token exchange waits before it is tried again. */
const MIGRATION_RETRY_MS = 10 * 60 * 1000;

class EncryptedSessionStorage {
  private current: PrismaSessionStorage<never> | null = null;
  private migrator: LegacyTokenMigrator | null = null;
  // Parallel loaders read the same session at once; Shopify revokes the legacy
  // token on the first exchange, so a second exchange would fail.
  private readonly migrating = new Map<string, Promise<Session | undefined>>();
  // A failed exchange is not retried on every load (each one a network call
  // of up to 20 seconds) but after a pause.
  private readonly failedMigrations = new Map<string, number>();

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
    return this.storeUnlessOlder(mapTokens(session, sealToken));
  }

  /**
   * Store an offline session unless the stored one is newer. Two refreshes or
   * a refresh and a migration can finish in either order; writing the older
   * result last left a token (and refresh token) Shopify had already replaced,
   * and every later refresh then failed until the merchant reopened the app.
   * A session with an expiry is newer than one without (a legacy token).
   */
  private async storeUnlessOlder(sealed: Session): Promise<boolean> {
    if (!sealed.isOnline) {
      const stored = await this.inner().loadSession(sealed.id);
      if (stored?.expires && (!sealed.expires || sealed.expires.getTime() < stored.expires.getTime())) {
        logger.info("session_store_skipped_older", { session_id: sealed.id });
        return true;
      }
    }
    return this.inner().storeSession(sealed);
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner().loadSession(id);
    if (!session) return undefined;
    // Seal a legacy plain-text row now, and re-seal one that still needs the
    // key being rotated out: a shop with no refresh during the rotation window
    // otherwise lost its tokens once that key was removed. Failing is logged.
    const rotated = sealedWithPreviousKey(session.accessToken) || sealedWithPreviousKey(session.refreshToken);
    const opened = mapTokens(session, (value) => openToken(value, { sessionId: id, shop: session.shop }));
    if (hasPlainToken(session) || rotated) {
      await this.storeUnlessOlder(mapTokens(opened, sealToken)).catch((error: unknown) => {
        logger.warn("session_token_reseal_failed", {
          session_id: id,
          error_message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return this.upgradeLegacy(opened);
  }

  /** Set once at startup by `shopify.server.ts`; unset, sessions load as stored. */
  useLegacyTokenMigration(migrator: LegacyTokenMigrator): void {
    this.migrator = migrator;
  }

  /**
   * Replace a non-expiring offline session with an expiring one. If the
   * exchange fails the legacy session is reported as absent, not returned: its
   * token only earns a 403, while no session makes the next admin open run
   * token exchange, which now asks for an expiring token.
   */
  private upgradeLegacy(session: Session): Promise<Session | undefined> {
    const migrator = this.migrator;
    if (!migrator || !isLegacyOfflineSession(session)) return Promise.resolve(session);
    const pending = this.migrating.get(session.id);
    if (pending) return pending;
    const failedAt = this.failedMigrations.get(session.id);
    if (failedAt !== undefined && Date.now() - failedAt < MIGRATION_RETRY_MS) return Promise.resolve(undefined);

    const run = (async () => {
      try {
        // Another load may have finished the exchange after this one read the
        // row: the legacy token is revoked by then, so use the stored result.
        const current = await this.inner().loadSession(session.id);
        if (current?.expires) {
          return mapTokens(current, (value) => openToken(value, { sessionId: session.id, shop: session.shop }));
        }
        const upgraded = await migrator(session);
        await this.storeSession(upgraded);
        logger.info("offline_token_migrated", { shop_domain: session.shop });
        this.failedMigrations.delete(session.id);
        return upgraded;
      } catch (error) {
        if (this.failedMigrations.size > 10_000) this.failedMigrations.clear();
        this.failedMigrations.set(session.id, Date.now());
        logger.warn("offline_token_migration_failed", {
          shop_domain: session.shop,
          error_message: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      } finally {
        this.migrating.delete(session.id);
      }
    })();
    this.migrating.set(session.id, run);
    return run;
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
