/**
 * The Prisma session storage writes `refreshToken` and `refreshTokenExpires`
 * on EVERY store, null or not. Without those columns each token exchange throws
 * PrismaClientValidationError, so no merchant can open the app.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Session } from "@shopify/shopify-api";

import { db } from "~/db.server";
import { sessionStorage } from "~/session-storage.server";

const SHOP = "session-store-test.myshopify.com";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

afterAll(async () => {
  await db.session.deleteMany({ where: { shop: SHOP } });
});

describe("Shopify session storage", () => {
  it("stores and loads an offline session with an expiring token", async () => {
    const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    const session = new Session({ id: `offline_${SHOP}`, shop: SHOP, state: "s", isOnline: false });
    session.accessToken = "shpat_x";
    session.scope = "read_orders";
    session.refreshToken = "shprt_x";
    session.refreshTokenExpires = expires;

    expect(await sessionStorage.storeSession(session)).toBe(true);

    const loaded = await sessionStorage.loadSession(`offline_${SHOP}`);
    expect(loaded?.refreshToken).toBe("shprt_x");
    expect(loaded?.refreshTokenExpires?.getTime()).toBe(expires.getTime());
  });

  it("stores a session without a refresh token", async () => {
    const session = new Session({ id: `offline2_${SHOP}`, shop: SHOP, state: "s", isOnline: false });
    session.accessToken = "shpat_y";
    expect(await sessionStorage.storeSession(session)).toBe(true);
  });

  it("encrypts tokens at rest and decrypts them on load", async () => {
    const session = new Session({ id: `offline3_${SHOP}`, shop: SHOP, state: "s", isOnline: false });
    session.accessToken = "shpat_secret_value";
    session.refreshToken = "shprt_secret_value";
    await sessionStorage.storeSession(session);

    const raw = await db.session.findUniqueOrThrow({ where: { id: `offline3_${SHOP}` } });
    expect(raw.accessToken).not.toContain("shpat_secret_value");
    expect(raw.refreshToken).not.toContain("shprt_secret_value");

    const loaded = await sessionStorage.loadSession(`offline3_${SHOP}`);
    expect(loaded?.accessToken).toBe("shpat_secret_value");
    expect(loaded?.refreshToken).toBe("shprt_secret_value");
    expect((await sessionStorage.findSessionsByShop(SHOP)).every((s) => !s.accessToken?.startsWith("enc:"))).toBe(true);
    // The caller's object is not mutated.
    expect(session.accessToken).toBe("shpat_secret_value");
  });

  it("still reads a row written in plain text before encryption", async () => {
    await db.session.create({ data: { id: `legacy_${SHOP}`, shop: SHOP, state: "s", accessToken: "shpat_legacy" } });
    expect((await sessionStorage.loadSession(`legacy_${SHOP}`))?.accessToken).toBe("shpat_legacy");
  });
});
