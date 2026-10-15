/**
 * Drives the REAL webhook route with a correctly signed request, so the topic
 * reaches the handlers exactly as `authenticate.webhook` hands it over.
 *
 * Every other webhook test calls `processWebhook("orders/create", ...)` directly.
 * That hid the fact that the library upper-cases the topic (`ORDERS_CREATE`): the
 * route passed it through, no handler matched, and in production not one order,
 * uninstall or GDPR redaction was ever applied while every test stayed green.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { action } from "~/routes/webhooks";

const prisma = new PrismaClient();
const DOMAIN = "webhook-route-test.myshopify.com";

function signed(topic: string, body: Record<string, unknown>, webhookId = `whroute-${randomUUID()}`): Request {
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "").update(raw, "utf8").digest("base64");
  return new Request("https://example.test/webhooks", {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": DOMAIN,
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Webhook-Id": webhookId,
    },
  });
}

async function cleanup() {
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "whroute-" } } });
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
}

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) {
    throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
  }
});

let shopId = "";
beforeEach(async () => {
  await cleanup();
  shopId = (
    await prisma.shop.create({
      data: { shopId: "gid://shopify/Shop/930000", shopDomain: DOMAIN, installState: "installed", checkoutSupported: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("POST /webhooks", () => {
  it("caches an order from a signed orders/create and reconciles its answer", async () => {
    await prisma.surveyResponse.create({ data: { shopId, orderId: "930001", channel: "instagram" } });

    const response = await action({
      request: signed("orders/create", {
        id: 930001,
        name: "#1001",
        currency: "USD",
        current_total_price: "25.00",
        financial_status: "paid",
        test: true,
        created_at: "2026-10-11T10:00:00Z",
        updated_at: "2026-10-11T10:00:00Z",
      }),
    });

    expect(response.status).toBe(200);
    const order = await prisma.orderCache.findUnique({ where: { shopId_orderId: { shopId, orderId: "930001" } } });
    expect(order).toMatchObject({ orderNumber: "#1001", currency: "USD", isTest: true });
    expect(order?.totalPrice?.toString()).toBe("25");
    const answer = await prisma.surveyResponse.findFirstOrThrow({ where: { shopId } });
    expect(answer.reconciled).toBe(true);
  });

  it("applies app/uninstalled", async () => {
    const response = await action({ request: signed("app/uninstalled", { id: 930000 }) });
    expect(response.status).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).installState).toBe("uninstalled");
  });

  it("applies app_subscriptions/update, whose topic keeps its underscore", async () => {
    await action({
      request: signed("app_subscriptions/update", {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/77",
          name: "SourceTrac Growth",
          status: "ACTIVE",
        },
      }),
    });
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).plan).toBe("growth");
  });

  it("erases the shop on shop/redact", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { installState: "uninstalled" } });
    const response = await action({ request: signed("shop/redact", { shop_domain: DOMAIN }) });
    expect(response.status).toBe(200);
    expect(await prisma.shop.findUnique({ where: { id: shopId } })).toBeNull();
  });

  it("asks Shopify to retry a delivery that is still being processed, and acks a finished one", async () => {
    await prisma.webhookEvent.create({ data: { webhookId: "whroute-inflight", topic: "orders/create" } });
    const busy = await action({ request: signed("orders/create", { id: 1 }, "whroute-inflight") });
    expect(busy.status).toBe(503);

    await prisma.webhookEvent.update({ where: { webhookId: "whroute-inflight" }, data: { processedAt: new Date() } });
    const done = await action({ request: signed("orders/create", { id: 1 }, "whroute-inflight") });
    expect(done.status).toBe(200);
  });

  it("rejects a bad signature", async () => {
    const request = signed("orders/create", { id: 1 });
    request.headers.set("X-Shopify-Hmac-Sha256", "forged");
    await expect(action({ request })).rejects.toMatchObject({ status: 401 });
  });
});
