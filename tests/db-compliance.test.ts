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

import { handleCustomerRedact, handleDataRequest, handleShopRedact, processPendingDeletions, REDACT_BATCH_SIZE } from "~/lib/compliance.server";
import { recordOrderFact } from "~/lib/order-facts.server";

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
  await prisma.pendingDeletion.deleteMany({ where: { shopId: { in: [SHOP_A, SHOP_B] } } });
  await prisma.dataRequest.deleteMany({ where: { shopId: { in: [SHOP_A, SHOP_B] } } });
  await prisma.pendingSync.deleteMany({ where: { shopId: { in: [SHOP_A, SHOP_B] } } });
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

  it("removes the v2 Response, its Answers and any PendingSync rows", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    const survey = await prisma.survey.create({
      data: { shopId: shop.id, name: "S", status: "active", placements: "[]", layout: "all" },
    });
    const question = await prisma.question.create({
      data: { surveyId: survey.id, type: "single_choice", text: "Q", position: 0 },
    });
    const response = await prisma.response.create({
      data: {
        shopId: shop.id, surveyId: survey.id, surveyVersion: 1, orderId: "7601", placement: "thank_you",
        answers: { create: [{ shopId: shop.id, questionId: question.id, optionIds: "[]" }] },
      },
    });
    await prisma.pendingSync.create({
      data: { shopId: shop.id, responseId: response.id, kind: "tags" },
    });

    const result = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7601"] });

    expect(result.deletedV2Responses).toBe(1);
    expect(await prisma.response.count({ where: { shopId: shop.id } })).toBe(0);
    // Answers cascade with their Response; PendingSync is removed explicitly
    // because it holds only a plain responseId, not a foreign key.
    expect(await prisma.answer.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await prisma.pendingSync.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("defers beyond the batch size and drains the rest lazily", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    const survey = await prisma.survey.create({
      data: { shopId: shop.id, name: "S", status: "active", placements: "[]", layout: "all" },
    });
    // REDACT_BATCH_SIZE is 200; 205 orders forces one deferred row.
    const ids = Array.from({ length: 205 }, (_, i) => String(7700 + i));
    await prisma.response.createMany({
      data: ids.map((orderId) => ({
        shopId: shop.id, surveyId: survey.id, surveyVersion: 1, orderId, placement: "thank_you" as const,
      })),
    });

    const first = await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ids });

    expect(first.deferred).toBe(true);
    expect(first.deletedV2Responses).toBe(REDACT_BATCH_SIZE);

    // The remaining 5 are drained in the background right after the webhook,
    // without waiting for the merchant to open the app (H19).
    for (let i = 0; i < 100 && (await prisma.pendingDeletion.count({ where: { shopId: shop.id } })) > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await prisma.response.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await prisma.pendingDeletion.count({ where: { shopId: shop.id } })).toBe(0);

    // A later explicit drain finds nothing left.
    const drained = await processPendingDeletions(shop.id);
    expect(drained).toEqual({ processed: 0, remaining: 0 });
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

    // shop/redact comes 48 hours after an uninstall. A shop whose current
    // installation began after that uninstall has reinstalled: nothing is
    // deleted (H20).
    await prisma.shop.update({ where: { id: shop.id }, data: { installedAt: new Date() } });
    const stale = await handleShopRedact({ shopDomain: DOMAIN_B, triggeredAt: new Date() });
    expect(stale.deleted).toBe(false);
    expect(await prisma.surveyResponse.count({ where: { shopId: shop.id } })).toBe(1);

    // Still marked installed only because the uninstall was never processed:
    // the installation predates the uninstall, so the redact proceeds.
    await prisma.shop.update({ where: { id: shop.id }, data: { installedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) } });
    const result = await handleShopRedact({ shopDomain: DOMAIN_B, triggeredAt: new Date() });

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

describe("customers/data_request records a notice for the merchant", () => {
  it("persists a DataRequest row and counts both response models", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "8101", channel: "google" } });
    const survey = await prisma.survey.create({
      data: { shopId: shop.id, name: "S", status: "active", placements: "[]", layout: "all" },
    });
    await prisma.response.create({
      data: { shopId: shop.id, surveyId: survey.id, surveyVersion: 1, orderId: "8102", placement: "thank_you" },
    });

    const result = await handleDataRequest({ shopDomain: DOMAIN_A, customerEmail: "buyer@example.com" });

    expect(result.shopFound).toBe(true);
    // The note counts both the legacy and the v2 rows.
    expect(result.note).toContain("2 survey response(s)");

    const rows = await prisma.dataRequest.findMany({ where: { shopId: shop.id } });
    expect(rows).toHaveLength(1);
    // We store the export summary, never the buyer's email.
    expect(rows[0]?.payload).not.toContain("buyer@example.com");
    expect(rows[0]?.customerId).toBeNull();
  });

  it("records nothing for a shop we do not know", async () => {
    const result = await handleDataRequest({ shopDomain: "never-installed.myshopify.com" });
    expect(result.shopFound).toBe(false);
  });
});

describe("2026-10-20 audit", () => {
  it("removes a redacted order's answers from a stored data-request export (M4)", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7101", channel: "other", otherText: "my secret" } });
    await prisma.surveyResponse.create({ data: { shopId: shop.id, orderId: "7102", channel: "instagram" } });
    await handleDataRequest({ shopDomain: DOMAIN_A, orderIds: ["7101", "7102"], webhookId: "dr-m4" });
    await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7101"] });
    const stored = await prisma.dataRequest.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(stored.payload).not.toContain("my secret");
    expect(stored.payload).not.toContain("7101");
    expect(stored.payload).toContain("7102");
  });

  it("exports the order data held for a named order, not only the answers (L18)", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.orderCache.create({
      data: {
        shopId: shop.id, orderId: "7201", currency: "EUR", totalPrice: "12.000",
        createdAtShop: new Date(), updatedAtShop: new Date(),
      },
    });
    await prisma.orderFact.create({ data: { shopId: shop.id, orderId: "7201", isFirstOrder: true } });
    await prisma.checkoutLoad.create({ data: { shopId: shop.id, orderId: "7201", reason: "shown", country: "DE" } });
    const result = await handleDataRequest({ shopDomain: DOMAIN_A, orderIds: ["7201"] });
    expect(result.orderData).toEqual([
      expect.objectContaining({
        orderId: "7201",
        isFirstOrder: true,
        order: expect.objectContaining({ total: "12", currency: "EUR" }),
        checkoutLoads: [expect.objectContaining({ country: "DE" })],
      }),
    ]);
  });

  it("never records a first-order flag for a redacted order again (L10)", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await handleCustomerRedact({ shopDomain: DOMAIN_A, orderIds: ["7301"] });
    await recordOrderFact(shop.id, "7301", true);
    expect(await prisma.orderFact.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("keeps a deferred redact it cannot read instead of dropping it (L13)", async () => {
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.pendingDeletion.create({ data: { shopId: shop.id, scope: "customer", payload: "{not json" } });
    await processPendingDeletions(shop.id);
    expect(await prisma.pendingDeletion.count({ where: { shopId: shop.id } })).toBe(1);
  });

  it("skips shop/redact after a reinstall even when Shopify sends it late (H1, M3)", async () => {
    const now = Date.now();
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    // Uninstalled 100 hours ago (recorded from app/uninstalled), reinstalled 90 hours ago.
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        installedAt: new Date(now - 200 * 3600_000),
        uninstallTriggeredAt: new Date(now - 100 * 3600_000),
        authorizedAt: new Date(now - 90 * 3600_000),
      },
    });
    const result = await handleShopRedact({ shopDomain: DOMAIN_A, triggeredAt: new Date(now) });
    expect(result.deleted).toBe(false);
    expect(await prisma.shop.count({ where: { id: shop.id } })).toBe(1);
  });

  it("redacts a shop still marked installed whose last install predates the uninstall (H1)", async () => {
    const now = Date.now();
    const shop = await seedShop(SHOP_A, DOMAIN_A);
    await prisma.shop.update({
      where: { id: shop.id },
      data: { installedAt: new Date(now - 200 * 3600_000), authorizedAt: new Date(now - 60 * 3600_000) },
    });
    const result = await handleShopRedact({ shopDomain: DOMAIN_A, triggeredAt: new Date(now) });
    expect(result.deleted).toBe(true);
  });
});
