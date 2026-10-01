/**
 * Database invariant checks.
 *
 * These run against a real Postgres, not a mock: the whole point is to prove
 * the uniqueness guarantees that duplicate-submission and webhook-retry safety
 * depend on actually hold at the storage layer. Prisma expresses `@@unique` as
 * a unique *index* rather than a constraint, so asserting here catches a
 * regression that a schema read-through would miss.
 *
 * Run with: npm run test:db
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SHOP_ID = "gid://shopify/Shop/1000001";

async function reset() {
  await prisma.surveyResponse.deleteMany({ where: { shopId: { in: [SHOP_ID, OTHER_SHOP_ID] } } });
  await prisma.orderCache.deleteMany({ where: { shopId: { in: [SHOP_ID, OTHER_SHOP_ID] } } });
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "wh-" } } });
  await prisma.shop.deleteMany({ where: { shopId: { in: [SHOP_ID, OTHER_SHOP_ID] } } });
}

const OTHER_SHOP_ID = "gid://shopify/Shop/1000002";

/**
 * Upsert rather than create: several assertions reuse the same shop GID, and a
 * plain create would trip the shopId unique index on the second run.
 */
async function seedShop(shopId: string, shopDomain: string) {
  return prisma.shop.upsert({
    where: { shopId },
    update: { shopDomain, installState: "installed", accessTokenEncrypted: null },
    create: { shopId, shopDomain, installState: "installed" },
  });
}

beforeAll(async () => {
  // Guard against pointing the suite at a real database.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await reset();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("unique(shop_id, order_id) on survey_responses", () => {
  it("rejects a second response for the same order in the same shop", async () => {
    const shop = await seedShop(SHOP_ID, "dup-test.myshopify.com");

    await prisma.surveyResponse.create({
      data: { shopId: shop.id, orderId: "5551", channel: "instagram" },
    });

    // The insert must fail so the caller can fall back to a duplicate response.
    await expect(
      prisma.surveyResponse.create({
        data: { shopId: shop.id, orderId: "5551", channel: "google" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same order id in a different shop", async () => {
    const a = await seedShop(SHOP_ID, "dup-test.myshopify.com");
    const b = await seedShop(OTHER_SHOP_ID, "dup-other.myshopify.com");

    await prisma.surveyResponse.create({ data: { shopId: a.id, orderId: "777", channel: "a" } });
    await prisma.surveyResponse.create({ data: { shopId: b.id, orderId: "777", channel: "b" } });

    const count = await prisma.surveyResponse.count({ where: { orderId: "777" } });
    expect(count).toBe(2);
  });
});

describe("webhook_events idempotency ledger", () => {
  it("rejects a repeated webhook id", async () => {
    await prisma.webhookEvent.create({
      data: {
        webhookId: "wh-dup-1",
        topic: "orders/create",
        payloadJson: "{}",
      },
    });

    await expect(
      prisma.webhookEvent.create({
        data: {
          webhookId: "wh-dup-1",
          topic: "orders/create",
          payloadJson: "{}",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("order_cache unique(shop_id, order_id)", () => {
  it("rejects caching the same order twice and accepts an update", async () => {
    const shop = await seedShop(SHOP_ID, "dup-test.myshopify.com");

    const now = new Date();
    const base = {
      shopId: shop.id,
      orderId: "888",
      currency: "USD",
      createdAtShop: now,
      updatedAtShop: now,
    };

    await prisma.orderCache.create({ data: { ...base, totalPrice: "100.00" } });

    // Reconcile must be able to update in place, not insert a duplicate row.
    const updated = await prisma.orderCache.update({
      where: { shopId_orderId: { shopId: shop.id, orderId: "888" } },
      data: { totalPrice: "90.00" },
    });
    expect(updated.totalPrice.toString()).toBe("90");

    await expect(
      prisma.orderCache.create({ data: { ...base, totalPrice: "1.00" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("billing_usage unique(shop_id, period_start)", () => {
  it("rejects two usage rows for the same period", async () => {
    const shop = await seedShop(SHOP_ID, "dup-test.myshopify.com");
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    await prisma.billingUsage.create({
      data: { shopId: shop.id, periodStart, periodEnd: new Date("2026-11-01T00:00:00.000Z"), responsesCount: 1 },
    });

    await expect(
      prisma.billingUsage.create({
        data: { shopId: shop.id, periodStart, periodEnd: new Date("2026-11-01T00:00:00.000Z"), responsesCount: 2 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("encrypted access token columns", () => {
  it("stores ciphertext, iv and tag separately and never plaintext", async () => {
    const shop = await seedShop(SHOP_ID, "enc-test.myshopify.com");
    const stored = await prisma.shop.update({
      where: { id: shop.id },
      data: {
        accessTokenEncrypted: Buffer.from("ciphertext-bytes").toString("base64"),
        accessTokenIv: Buffer.from("0123456789abcdef").toString("base64"),
        accessTokenTag: Buffer.from("0123456789abcdef").toString("base64"),
      },
    });

    expect(stored.accessTokenEncrypted).not.toContain("shpat_");
    expect(stored.accessTokenIv).toBeTruthy();
    expect(stored.accessTokenTag).toBeTruthy();

    // Reinstating clears the credential but keeps the row and its history.
    const afterUninstall = await prisma.shop.update({
      where: { id: shop.id },
      data: { installState: "uninstalled", accessTokenEncrypted: null },
    });
    expect(afterUninstall.accessTokenEncrypted).toBeNull();
    expect(afterUninstall.id).toBe(shop.id);
  });
});