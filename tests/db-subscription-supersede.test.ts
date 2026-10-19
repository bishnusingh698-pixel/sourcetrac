/**
 * A plan change creates a new subscription and Shopify cancels the old one.
 * The old charge's CANCELLED notice can arrive after the new one is ACTIVE;
 * it must not drop the merchant who just paid back to the free cap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { processWebhook } from "~/lib/webhooks.server";

const prisma = new PrismaClient();
const DOMAIN = "supersede-test.myshopify.com";
const OLD = "gid://shopify/AppSubscription/1";
const NEW = "gid://shopify/AppSubscription/2";

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await cleanup();
  await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9200001" });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const notice = (gid: string, name: string, status: string) =>
  processWebhook({
    topic: "app_subscriptions/update",
    shopDomain: DOMAIN,
    accessToken: null,
    // Shopify's real shape: the subscription is nested under `app_subscription`.
    payload: {
      app_subscription: {
        admin_graphql_api_id: gid,
        name,
        status,
        admin_graphql_api_shop_id: "gid://shopify/Shop/9200001",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        currency: "USD",
      },
    },
  });

describe("app_subscriptions/update ordering", () => {
  it("ignores a late cancellation of a superseded subscription", async () => {
    await notice(OLD, "SourceTrac Growth", "ACTIVE");
    await notice(NEW, "SourceTrac Scale", "ACTIVE");
    await notice(OLD, "SourceTrac Growth", "CANCELLED");

    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } });
    expect(shop.plan).toBe("scale");
    expect(shop.planStatus).toBe("active");
    expect(shop.subscriptionGid).toBe(NEW);
  });

  it("still applies a cancellation of the current subscription", async () => {
    await notice(NEW, "SourceTrac Scale", "CANCELLED");
    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } });
    expect(shop.planStatus).toBe("cancelled");
  });
});

describe("test charges in production", () => {
  it("never grant a paid plan through the webhook", async () => {
    // The Plans page already ignored test charges in production; the webhook
    // path applied them, handing out a paid plan for nothing.
    await prisma.shop.update({
      where: { shopDomain: DOMAIN },
      data: { plan: "free", planStatus: "active", subscriptionGid: null },
    });
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await processWebhook({
        topic: "app_subscriptions/update",
        shopDomain: DOMAIN,
        accessToken: null,
        payload: { admin_graphql_api_id: "gid://shopify/AppSubscription/3", name: "SourceTrac Growth", status: "ACTIVE", test: true },
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } });
    expect(shop.plan).toBe("free");
  });
});

describe("uninstall ends the paid plan", () => {
  it("a reinstall starts on Free instead of keeping a subscription Shopify cancelled", async () => {
    await notice(NEW, "SourceTrac Scale", "ACTIVE");
    expect((await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } })).plan).toBe("scale");

    await processWebhook({ topic: "app/uninstalled", shopDomain: DOMAIN, accessToken: null, payload: {} });
    await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9200001" });

    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } });
    expect(shop).toMatchObject({ plan: "free", subscriptionGid: null });
  });

  it("ignores a late ACTIVE notice for the old charge once the app is uninstalled", async () => {
    await notice(NEW, "SourceTrac Scale", "ACTIVE");
    await processWebhook({ topic: "app/uninstalled", shopDomain: DOMAIN, accessToken: null, payload: {} });
    await notice(NEW, "SourceTrac Scale", "ACTIVE");
    await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9200001" });

    expect((await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } })).plan).toBe("free");
  });
});
