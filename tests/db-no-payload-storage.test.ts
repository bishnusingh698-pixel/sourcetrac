/**
 * The webhook ledger must never retain a payload body.
 *
 * An orders/* webhook embeds a complete customer object -- name, email, phone,
 * address. SourceTrac exists so a merchant can attribute revenue, and it
 * deliberately holds none of that. Storing the payload anyway made the app the
 * one place a buyer's contact details were collected without being used, which
 * is both a GDPR minimization failure and the largest storage cost in the
 * schema.
 *
 * The assertion is on the persisted column rather than on source text, so a
 * future change that reintroduces the write fails here even if it is added
 * somewhere else entirely.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";

import { PrismaClient } from "@prisma/client";

import { claimWebhook, markWebhookProcessed, processWebhook } from "~/lib/webhooks.server";

const prisma = new PrismaClient();

const SHOP = "gid://shopify/Shop/3100001";

/**
 * A realistic orders/create body, trimmed to the fields that matter for this
 * assertion. The customer object is the whole point: it is what the payload
 * column used to capture.
 */
const CUSTOMER = {
  id: 900001,
  email: "buyer@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  phone: "+15555550100",
};

const ORDER_PAYLOAD = {
  id: 730001,
  name: "#1001",
  email: "buyer@example.com",
  contact_email: "buyer@example.com",
  customer: CUSTOMER,
  currency: "USD",
  current_total_price: "42.00",
  total_price: "42.00",
  total_refunded: "0.00",
  financial_status: "paid",
  test: false,
  cancelled_at: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
};

/**
 * The shop row is created before each test: a webhook never creates or revives a
 * shop (only the auth path does), so processWebhook ignores an unknown shop.
 */
async function reset() {
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "nopay-" } } });
  await prisma.surveyResponse.deleteMany({ where: { shopId: SHOP } });
  await prisma.orderCache.deleteMany({ where: { shopId: SHOP } });
  await prisma.shop.deleteMany({ where: { shopId: SHOP } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!/_test/.test(url)) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
  await prisma.$connect();
});

beforeEach(async () => {
  await reset();
  await prisma.shop.create({
    data: { shopId: SHOP, shopDomain: "nopayload.myshopify.com", installState: "installed" },
  });
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("webhook ledger stores no payload", () => {
  it("leaves payloadJson null after claiming a delivery", async () => {
    await claimWebhook({ webhookId: "nopay-1", topic: "orders/create", apiVersion: "2026-07" });

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: "nopay-1" } });
    expect(row.payloadJson).toBeNull();
  });

  it("still records everything the idempotency ledger needs", async () => {
    await claimWebhook({ webhookId: "nopay-2", topic: "orders/create", apiVersion: "2026-07" });

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: "nopay-2" } });
    expect(row.webhookId).toBe("nopay-2");
    expect(row.topic).toBe("orders/create");
    expect(row.apiVersion).toBe("2026-07");
  });

  it("leaves payloadJson null after a real order is processed", async () => {
    await claimWebhook({ webhookId: "nopay-3", topic: "orders/create", apiVersion: "2026-07" });
    await processWebhook({
      shopDomain: "nopayload.myshopify.com",
      topic: "orders/create",
      payload: ORDER_PAYLOAD,
      accessToken: null,
    });
    await markWebhookProcessed("nopay-3", null);

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { webhookId: "nopay-3" } });
    expect(row.payloadJson).toBeNull();
    expect(row.processedAt).not.toBeNull();
  });

  it("stores no buyer contact detail anywhere in the ledger", async () => {
    await claimWebhook({ webhookId: "nopay-4", topic: "orders/create", apiVersion: "2026-07" });
    await processWebhook({
      shopDomain: "nopayload.myshopify.com",
      topic: "orders/create",
      payload: ORDER_PAYLOAD,
      accessToken: null,
    });
    await markWebhookProcessed("nopay-4", null);

    const rows = await prisma.webhookEvent.findMany({ where: { webhookId: { startsWith: "nopay-" } } });
    expect(rows.length).toBeGreaterThan(0);

    // Serialise every stored column the app owns and assert no customer detail
    // survived. This catches a reintroduced payload as well as a new column that
    // quietly keeps contact details.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain("buyer@example.com");
    expect(serialised).not.toContain("Lovelace");
    expect(serialised).not.toContain("+15555550100");
  });

  it("keeps the cached order free of customer contact details", async () => {
    await claimWebhook({ webhookId: "nopay-5", topic: "orders/create", apiVersion: "2026-07" });
    await processWebhook({
      shopDomain: "nopayload.myshopify.com",
      topic: "orders/create",
      payload: ORDER_PAYLOAD,
      accessToken: null,
    });

    // By orderId, not shopId: the internal shop row's id is a cuid, so SHOP above
    // is the Shopify GID rather than the FK.
    const order = await prisma.orderCache.findFirstOrThrow({ where: { orderId: "730001" } });
    const serialised = JSON.stringify(order);
    expect(serialised).not.toContain("buyer@example.com");
    expect(serialised).not.toContain("Lovelace");
    expect(serialised).not.toContain("+15555550100");
  });
});