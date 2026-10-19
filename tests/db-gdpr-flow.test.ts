/**
 * Uninstall, GDPR and retention (GDPR flow), against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { handleCustomerRedact, handleDataRequest, REDACT_BATCH_SIZE } from "~/lib/compliance.server";
import { submitResponse } from "~/lib/responses.server";
import { runRetentionPurge } from "~/lib/retention.server";
import { upsertShop } from "~/lib/shop.server";
import { processWebhook, upsertOrderCache } from "~/lib/webhooks.server";

const prisma = new PrismaClient();
const DOMAIN = "gdpr-flow-test.myshopify.com";
let shopId = "";
let surveyId = "";

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/950000" });
  shopId = shop.id;
  surveyId = (await prisma.survey.create({ data: { shopId, name: "S", placements: '["thank_you"]' } })).id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.$disconnect();
});

const order = (id: number) =>
  ({
    id, currency: "USD", current_total_price: "10.00", financial_status: "paid", test: false, cancelled_at: null,
    created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z",
  }) as never;

describe("uninstall", () => {
  it("ignores a late app/uninstalled from before a reinstall (M10)", async () => {
    await prisma.session.create({ data: { id: "s-gdpr", shop: DOMAIN, state: "s", isOnline: false, accessToken: "x" } });
    const beforeReinstall = new Date(Date.now() - 60 * 60 * 1000);
    await processWebhook({ topic: "app/uninstalled", shopDomain: DOMAIN, payload: {}, accessToken: null, triggeredAt: beforeReinstall });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.installState).toBe("installed");
    expect(await prisma.session.count({ where: { shop: DOMAIN } })).toBe(1);
  });

  it("never flips an uninstalled shop back to installed from a webhook (L1)", async () => {
    await processWebhook({ topic: "app/uninstalled", shopDomain: DOMAIN, payload: {}, accessToken: null });
    // A late order webhook, with a session token, must not resurrect the shop.
    const now = new Date().toISOString();
    await processWebhook({
      topic: "orders/create",
      shopDomain: DOMAIN,
      payload: { id: 950777, currency: "USD", current_total_price: "1.00", created_at: now, updated_at: now },
      accessToken: "shpat_revoked",
    });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.installState).toBe("uninstalled");
    expect(shop.accessTokenEncrypted).toBeNull();
  });
});

describe("customers/data_request (M12, L26)", () => {
  it("reports the named orders' answers once per delivery", async () => {
    await prisma.response.create({
      data: { shopId, surveyId, surveyVersion: 1, orderId: "950001", placement: "thank_you" },
    });
    await prisma.response.create({
      data: { shopId, surveyId, surveyVersion: 1, orderId: "950099", placement: "thank_you" },
    });
    const result = await handleDataRequest({ shopDomain: DOMAIN, orderIds: ["950001"], webhookId: "dr-1" });
    expect(result.ordersFound).toEqual(["950001"]);
    await handleDataRequest({ shopDomain: DOMAIN, orderIds: ["950001"], webhookId: "dr-1" });
    expect(await prisma.dataRequest.count({ where: { shopId } })).toBe(1);
  });
});

describe("customers/redact", () => {
  it("never stores a redacted order again (L28)", async () => {
    await upsertOrderCache(shopId, order(950010), false);
    await handleCustomerRedact({ shopDomain: DOMAIN, orderIds: ["950010"] });
    const again = await upsertOrderCache(shopId, order(950010), false);
    expect(again?.applied).toBe(false);
    expect(await prisma.orderCache.count({ where: { shopId, orderId: "950010" } })).toBe(0);
    // Nor through the legacy single-question path.
    const legacy = await submitResponse({ shopId, orderId: "950010", channel: "google", otherText: null, locale: null, plan: "growth" });
    expect(legacy.outcome).toBe("duplicate");
    expect(await prisma.surveyResponse.count({ where: { shopId } })).toBe(0);
  });

  it("drains a large redact without anyone opening the app, and queues it once (H19, L26)", async () => {
    const ids = Array.from({ length: REDACT_BATCH_SIZE + 5 }, (_, i) => String(951000 + i));
    await prisma.response.createMany({
      data: ids.map((orderId) => ({ shopId, surveyId, surveyVersion: 1, orderId, placement: "thank_you" as const })),
    });
    await handleCustomerRedact({ shopDomain: DOMAIN, orderIds: ids, webhookId: "cr-1" });
    for (let i = 0; i < 100 && (await prisma.response.count({ where: { shopId } })) > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await prisma.response.count({ where: { shopId } })).toBe(0);
    // A retried delivery does not queue the work again.
    await handleCustomerRedact({ shopDomain: DOMAIN, orderIds: ids, webhookId: "cr-1" });
    for (let i = 0; i < 50 && (await prisma.pendingDeletion.count({ where: { shopId } })) > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await prisma.pendingDeletion.count({ where: { shopId } })).toBe(0);
  });
});

describe("retention", () => {
  it("ages orders by order date and deletes shops whose redact never came (L31, L32)", async () => {
    const old = new Date(Date.now() - 800 * 24 * 60 * 60 * 1000);
    await prisma.orderCache.create({
      data: { shopId, orderId: "950200", currency: "USD", totalPrice: "1.00", createdAtShop: old, updatedAtShop: old },
    });
    const gone = await upsertShop({ shopDomain: "gdpr-gone.myshopify.com", shopId: "gid://shopify/Shop/950001" });
    await prisma.shop.update({
      where: { id: gone.id },
      data: { installState: "uninstalled", uninstalledAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    await runRetentionPurge();

    expect(await prisma.orderCache.count({ where: { shopId, orderId: "950200" } })).toBe(0);
    expect(await prisma.shop.count({ where: { id: gone.id } })).toBe(0);
    expect(await prisma.shop.count({ where: { id: shopId } })).toBe(1);
  });
});
