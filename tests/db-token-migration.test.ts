/**
 * Shopify refuses non-expiring offline tokens on the Admin API, and the
 * library never replaces an offline session that has no expiry. These drive
 * the real session storage against Postgres; only Shopify's token endpoint is
 * stood in for, by the migrator the storage is handed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Session } from "@shopify/shopify-api";

import { db } from "~/db.server";
import { getAccessToken, upsertShop } from "~/lib/shop.server";
import { sessionFromTokenResponse } from "~/lib/token-migration.server";
import { encryptSecret } from "~/lib/crypto.server";
import { sessionStorage } from "~/session-storage.server";

const SHOP = "token-migration-test.myshopify.com";
const ID = `offline_${SHOP}`;

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

async function cleanup() {
  await db.session.deleteMany({ where: { shop: SHOP } });
  await db.shop.deleteMany({ where: { shopDomain: SHOP } });
}
beforeEach(cleanup);
afterAll(cleanup);
afterEach(() => sessionStorage.useLegacyTokenMigration(async () => Promise.reject(new Error("no migrator in this test"))));

function legacySession(): Session {
  const session = new Session({ id: ID, shop: SHOP, state: "", isOnline: false });
  session.accessToken = "shpat_legacy";
  session.scope = "read_orders";
  return session;
}

function expiringFrom(legacy: Session): Session {
  return sessionFromTokenResponse(legacy, {
    access_token: "shpat_expiring",
    scope: "read_orders",
    expires_in: 3600,
    refresh_token: "shprt_new",
    refresh_token_expires_in: 90 * 24 * 3600,
  });
}

describe("legacy offline token migration", () => {
  it("swaps a non-expiring session for an expiring one, once for parallel loads", async () => {
    await sessionStorage.storeSession(legacySession());
    let calls = 0;
    sessionStorage.useLegacyTokenMigration(async (legacy) => {
      calls += 1;
      expect(legacy.accessToken).toBe("shpat_legacy");
      return expiringFrom(legacy);
    });

    const [a, b] = await Promise.all([sessionStorage.loadSession(ID), sessionStorage.loadSession(ID)]);
    expect(calls).toBe(1);
    expect(a?.accessToken).toBe("shpat_expiring");
    expect(b?.accessToken).toBe("shpat_expiring");

    const stored = await db.session.findUniqueOrThrow({ where: { id: ID } });
    expect(stored.expires).not.toBeNull();
    expect(stored.refreshToken).not.toContain("shprt_new"); // sealed at rest
    const reloaded = await sessionStorage.loadSession(ID);
    expect(reloaded?.refreshToken).toBe("shprt_new");
    expect(calls).toBe(1); // an expiring session is never migrated again
  });

  it("reports the session absent when the exchange fails, so token exchange runs", async () => {
    await sessionStorage.storeSession(legacySession());
    sessionStorage.useLegacyTokenMigration(async () => {
      throw new Error("Shopify returned 400");
    });

    expect(await sessionStorage.loadSession(ID)).toBeUndefined();
    // Nothing was deleted: the next token exchange overwrites the row.
    expect(await db.session.count({ where: { id: ID } })).toBe(1);
  });

  it("leaves online sessions alone", async () => {
    const online = new Session({ id: `online_${SHOP}`, shop: SHOP, state: "", isOnline: true });
    online.accessToken = "shpua_online";
    await sessionStorage.storeSession(online);
    let calls = 0;
    sessionStorage.useLegacyTokenMigration(async (legacy) => {
      calls += 1;
      return legacy;
    });
    expect((await sessionStorage.loadSession(`online_${SHOP}`))?.accessToken).toBe("shpua_online");
    expect(calls).toBe(0);
  });
});

describe("getAccessToken", () => {
  it("reads the live offline session", async () => {
    const { id } = await upsertShop({ shopDomain: SHOP, shopId: "gid://shopify/Shop/990001" });
    const live = expiringFrom(legacySession());
    await sessionStorage.storeSession(live);

    expect(await getAccessToken(id)).toBe("shpat_expiring");
  });

  it("returns null without a session, never an old stored copy Shopify would refuse", async () => {
    const { id } = await upsertShop({ shopDomain: SHOP, shopId: "gid://shopify/Shop/990001" });
    // A copy left on the row by an older version: a non-expiring token.
    const copy = encryptSecret("shpat_legacy_copy");
    await db.shop.update({
      where: { id },
      data: { accessTokenEncrypted: copy.ciphertext, accessTokenIv: copy.iv, accessTokenTag: copy.tag },
    });
    expect(await getAccessToken(id)).toBeNull();
  });

  it("never stores a token on the shop row", async () => {
    const { id } = await upsertShop({ shopDomain: SHOP, shopId: "gid://shopify/Shop/990001" });
    const row = await db.shop.findUniqueOrThrow({ where: { id } });
    expect(row.accessTokenEncrypted).toBeNull();
  });
});

describe("sessionFromTokenResponse", () => {
  it("keeps the legacy id and computes both expiries", () => {
    const now = Date.UTC(2026, 9, 18);
    const session = sessionFromTokenResponse(
      legacySession(),
      { access_token: "a", expires_in: 3600, refresh_token: "r", refresh_token_expires_in: 7200 },
      now,
    );
    expect(session.id).toBe(ID);
    expect(session.isOnline).toBe(false);
    expect(session.expires?.getTime()).toBe(now + 3600_000);
    expect(session.refreshTokenExpires?.getTime()).toBe(now + 7200_000);
    expect(session.scope).toBe("read_orders");
  });

  it("refuses an answer with no expiring token", () => {
    expect(() => sessionFromTokenResponse(legacySession(), { access_token: "a" })).toThrow();
  });
});

describe("wiring", () => {
  const source = readFileSync(fileURLToPath(new URL("../app/shopify.server.ts", import.meta.url)), "utf8");
  it("asks Shopify for expiring offline tokens", () => {
    expect(source).toMatch(/future:\s*\{\s*expiringOfflineAccessTokens:\s*true\s*\}/);
  });
  it("migrates sessions stored before that", () => {
    expect(source).toContain("sessionStorage.useLegacyTokenMigration(migrateToExpiringToken)");
  });
});
