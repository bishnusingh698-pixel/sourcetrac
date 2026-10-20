/**
 * Auth and token-lifecycle fixes from the 2026-10-20 audit, against the real
 * session storage and Postgres. Nothing calls Shopify: the legacy-token
 * migrator is handed in, as in tests/db-token-migration.test.ts.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A key being rotated out, set before anything reads the environment.
const PREVIOUS_KEY = vi.hoisted(() => {
  const key = "ab".repeat(32);
  process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = key;
  return key;
});

import { Session } from "@shopify/shopify-api";

import { db } from "~/db.server";
import { upsertShop } from "~/lib/shop.server";
import { IdTokenError, verifyIdToken } from "~/lib/id-token.server";
import { sessionStorage } from "~/session-storage.server";

const SHOP = "auth-audit-test.myshopify.com";
const ID = `offline_${SHOP}`;

function sealWith(hexKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

function opensWith(hexKey: string, sealed: string): boolean {
  const [iv = "", tag = "", ciphertext = ""] = sealed.slice("enc:v1:".length).split(":");
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    decipher.update(Buffer.from(ciphertext, "base64"));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

function expiring(token: string, expiresInMs: number): Session {
  const session = new Session({ id: ID, shop: SHOP, state: "", isOnline: false });
  session.accessToken = token;
  session.scope = "read_orders";
  session.expires = new Date(Date.now() + expiresInMs);
  session.refreshToken = `${token}-refresh`;
  return session;
}

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

async function cleanup() {
  await db.session.deleteMany({ where: { shop: SHOP } });
  await db.shop.deleteMany({ where: { shopDomain: { in: [SHOP, "auth-audit-renamed.myshopify.com"] } } });
}
beforeEach(cleanup);
afterAll(cleanup);

describe("session storage (2026-10-20 audit)", () => {
  it("re-seals a token that still needs the key being rotated out (L21)", async () => {
    await sessionStorage.storeSession(expiring("shpat_rotating", 3600_000));
    await db.session.update({ where: { id: ID }, data: { accessToken: sealWith(PREVIOUS_KEY, "shpat_rotating") } });

    const loaded = await sessionStorage.loadSession(ID);
    expect(loaded?.accessToken).toBe("shpat_rotating");
    const row = await db.session.findUniqueOrThrow({ where: { id: ID } });
    expect(opensWith(PREVIOUS_KEY, row.accessToken)).toBe(false);
    expect(opensWith(process.env.TOKEN_ENCRYPTION_KEY!, row.accessToken)).toBe(true);
  });

  it("never stores an older offline session over a newer one (M2, L19)", async () => {
    const newer = expiring("shpat_newer", 3600_000);
    const older = expiring("shpat_older", 1800_000);
    await sessionStorage.storeSession(newer);
    await sessionStorage.storeSession(older);
    expect((await sessionStorage.loadSession(ID))?.accessToken).toBe("shpat_newer");
  });

  it("does not retry a failed legacy exchange on every load (L20)", async () => {
    const legacy = new Session({ id: ID, shop: SHOP, state: "", isOnline: false });
    legacy.accessToken = "shpat_legacy";
    await sessionStorage.storeSession(legacy);
    let calls = 0;
    sessionStorage.useLegacyTokenMigration(async () => {
      calls += 1;
      throw new Error("Shopify returned 400");
    });
    expect(await sessionStorage.loadSession(ID)).toBeUndefined();
    expect(await sessionStorage.loadSession(ID)).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("provisioning (2026-10-20 audit)", () => {
  it("moves a shop to its new myshopify domain instead of failing (L24)", async () => {
    const { id } = await upsertShop({ shopDomain: "auth-audit-renamed.myshopify.com", shopId: "gid://shopify/Shop/995001" });
    const again = await upsertShop({ shopDomain: SHOP, shopId: "gid://shopify/Shop/995001" });
    expect(again.id).toBe(id);
    expect((await db.shop.findUniqueOrThrow({ where: { id } })).shopDomain).toBe(SHOP);
  });
});

describe("verifyIdToken (I20)", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (header: string, payload: string) =>
    createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "").update(`${header}.${payload}`).digest("base64url");

  it("answers a JSON null claims set with IdTokenError, not a TypeError", () => {
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode(null);
    expect(() => verifyIdToken(`${header}.${payload}.${sign(header, payload)}`)).toThrow(IdTokenError);
  });

  it("refuses a signature with characters the base64 decoder would skip", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ dest: SHOP, iss: `https://${SHOP}/admin`, aud: process.env.SHOPIFY_API_KEY, exp: now + 60 });
    const signature = sign(header, payload);
    expect(verifyIdToken(`${header}.${payload}.${signature}`).dest).toBe(SHOP);
    expect(() => verifyIdToken(`${header}.${payload}.${signature}!!`)).toThrow(IdTokenError);
  });
});
