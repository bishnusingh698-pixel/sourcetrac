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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { action } from "~/routes/webhooks";

const prisma = new PrismaClient();
const DOMAIN = "webhook-route-test.myshopify.com";

function signed(
  topic: string,
  body: Record<string, unknown>,
  webhookId = `whroute-${randomUUID()}`,
  extraHeaders: Record<string, string> = {},
): Request {
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
      ...extraHeaders,
    },
  });
}

async function cleanup() {
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
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

afterEach(() => vi.unstubAllGlobals());

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

  it("applies app/uninstalled even when Shopify refuses to refresh the offline token (C2)", async () => {
    // An expiring session past its expiry, with a refresh token Shopify has
    // revoked: the library's own webhook auth tried to refresh it and threw.
    await prisma.session.create({
      data: {
        id: `offline_${DOMAIN}`, shop: DOMAIN, state: "s", isOnline: false, scope: "read_orders", accessToken: "old",
        expires: new Date(Date.now() - 60_000), refreshToken: "revoked", refreshTokenExpires: new Date(Date.now() + 86_400_000),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_subject_token" }), { status: 400 })),
    );
    const response = await action({ request: signed("app/uninstalled", { id: 930000 }) });
    expect(response.status).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).installState).toBe("uninstalled");
    expect(await prisma.session.count({ where: { shop: DOMAIN } })).toBe(0);
  });

  it("ignores a late app/uninstalled once Shopify granted a token after it (H1)", async () => {
    const uninstalledAt = new Date(Date.now() - 5 * 60_000);
    // The first delivery failed, so the reinstall kept the old installedAt.
    await prisma.shop.update({
      where: { id: shopId },
      data: { installedAt: new Date(Date.now() - 86_400_000), authorizedAt: new Date(Date.now() - 2 * 60_000) },
    });
    const response = await action({
      request: signed("app/uninstalled", { id: 930000 }, undefined, { "X-Shopify-Triggered-At": uninstalledAt.toISOString() }),
    });
    expect(response.status).toBe(200);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    expect(shop.installState).toBe("installed");
    // Still remembered, for a later shop/redact.
    expect(shop.uninstallTriggeredAt?.toISOString()).toBe(uninstalledAt.toISOString());
  });

  it("ignores a scopes update older than the latest token grant (L17)", async () => {
    await prisma.session.create({
      data: { id: `offline_${DOMAIN}`, shop: DOMAIN, state: "s", isOnline: false, scope: "read_orders,write_orders", accessToken: "x" },
    });
    await prisma.shop.update({ where: { id: shopId }, data: { authorizedAt: new Date() } });
    await action({
      request: signed("app/scopes_update", { current: ["read_orders"] }, undefined, {
        "X-Shopify-Triggered-At": new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    expect((await prisma.session.findFirstOrThrow({ where: { shop: DOMAIN } })).scope).toBe("read_orders,write_orders");
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
