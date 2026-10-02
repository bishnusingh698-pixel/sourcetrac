/**
 * Compliance webhook behaviour against a real Postgres.
 *
 * `customers/redact` is the only Shopify-mandated webhook that deletes
 * customer-linked rows, and it previously deleted nothing at all: it received
 * `orders_to_redact` from Shopify, ignored it, logged a justification and
 * returned 0. Every assertion here fails against that implementation.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import { PrismaClient } from "@prisma/client";

import { handleCustomerRedact, handleShopRedact } from "~/lib/compliance.server";

const prisma = new PrismaClient();

const SHOP_A = "gid://shopify/Shop/2000001";
const SHOP_B = "gid://shopify/Shop/2000002";
const DOMAIN_A = "redact-a.myshopify.com";
const DOMAIN_B = "redact-b.myshopify.com";

async function seedShop(shopId: string, shopDomain: string) {
  return prisma.shop.upsert({
    where: { shopId },
    update: { shopDomain, installState: "installed" },
    create: { shopId, shopDomain, installState: "installed" },
  });
}

async function reset() {
  await prisma.surveyResponse.deleteMany({ where: { shopId: { in: [SHOP_A, SHOP_B] } } });
  await prisma.orderCache.deleteMany({ where: { shopId: { in: [SHOP_A, SHOP_B] } } });
  await prisma.shop.deleteMany({ where: { shopId: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

// Per-test, not just once: several cases seed the same shop and assert exact
// row counts, so leftovers from a sibling case would read as a leak.
beforeEach(reset);

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("customers/redact deletes the orders Shopify names", () => {
  it("removes the response and order row for each redacted order", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);

    await prisma.surveyResponse.create({
      data: { shopId: shop.id, orderId: "7001", channel: "instagram", orderTotal: "42.500" },
    });
    await prisma.orderCache.create({
      data: {
        shopId: shop.id, orderId: "7001", currency: "USD",
        totalPrice: "42.500", createdAtShop: new Date(), updatedAtShop: new Date(),
      },
    });

    const result = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7001"] });

    expect(result.shopFound).toBe(true);
    expect(result.deletedResponses).toBe(1);
    expect(result.deletedOrders).toBe(1);
    expect(await prisma.surveyResponse.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await prisma.orderCache.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("leaves every other buyer on the same shop untouched", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);

    // Two different buyers on one shop. Redacting one must not touch the other.
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7101", channel: "google" } });
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7102", channel: "tiktok" } });
    await prisma.orderCache.create({
      data: {
        shopId: shop.id, orderId: "7102", currency: "USD",
        totalPrice: "10.000", createdAtShop: new Date(), updatedAtShop: new Date(),
      },
    });

    const result = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7101"] });

    expect(result.deletedResponses).toBe(1);
    const survivors = await prisma.surveyResponse.findMany({
      where: { shopId: shop.id }, select: { orderId: true },
    });
    expect(survivors.map((r) => r.orderId)).toEqual(["7102"]);
    // The order cache row for the surviving response must survive too.
    expect(await prisma.orderCache.count({ where: { shopId: shop.id } })).toBe(1);
  });

  it("never deletes another shop's rows even when order ids collide", async () => {
    const a = await seedShop(SHOP_A, DOMAIN_A);
    const b = await seedShop(SHOP_B, DOMAIN_B);

    // Same numeric order id in two shops. Shopify order ids are per-shop.
    await prisma.surveyResponse.create({ data: { shopId: a.id, orderId: "7200", channel: "friend" } });
    await prisma.surveyResponse.create({ data: { shopId: b.id, orderId: "7200", channel: "friend" } });

    await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7200"] });

    expect(await prisma.surveyResponse.count({ where: { shopId: a.id } })).toBe(0);
    expect(await prisma.surveyResponse.count({ where: { shopId: b.id } })).toBe(1);
  });

  it("is idempotent when Shopify retries the same webhook", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7301", channel: "google" } });

    const first = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7301"] });
    const second = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7301"] });

    expect(first.deletedResponses).toBe(1);
    // A retry must report zero deleted, not error or double-count.
    expect(second.deletedResponses).toBe(0);
    expect(second.deletedOrders).toBe(0);
  });

  it("handles an empty orders_to_redact without error", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7401", channel: "google" } });

    const result = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: [] });

    expect(result.shopFound).toBe(true);
    expect(result.deletedResponses).toBe(0);
    // Nothing was attributable, so nothing may be destroyed.
    expect(await prisma.surveyResponse.count({ where: { shopId: shop.id } })).toBe(1);
  });

  it("reports no shop when the domain is unknown", async () => {
    const result = await handleCustomerRedact({
      shopDomain: "never-installed.myshopify.com", orderIds: ["1"],
    });
    expect(result.shopFound).toBe(false);
  });

  it("de-duplicates repeated order ids in one payload", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7501", channel: "tiktok" } });

    const result = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7501", "7501", "7501"] });

    expect(result.deletedResponses).toBe(1);
  });
});

describe("shop/redact removes the whole shop", () => {
  it("cascades to responses and orders", async () => {
    const shop = await seedShop(SHOP_B, DOMAIN_B);
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "8001", channel: "instagram" } });
    await prisma.orderCache.create({
      data: {
        shopId: shop.id, orderId: "8001", currency: "USD",
        totalPrice: "9.990", createdAtShop: new Date(), updatedAtShop: new Date(),
      },
    });

    const result = await handleShopRedact({ shopDomain: DOMAIN_B });

    expect(result.deleted).toBe(true);
    expect(await prisma.shop.count({ where: { id: shop.id } })).toBe(0);
    expect(await prisma.surveyResponse.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await prisma.orderCache.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("is a safe no-op for an unknown shop", async () => {
    const result = await handleShopRedact({ shopDomain: "nobody.myshopify.com" });
    expect(result.shopFound).toBe(false);
    expect(result.deleted).toBe(false);
  });
});