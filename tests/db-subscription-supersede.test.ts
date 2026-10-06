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
  await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9200001", accessToken: null });
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
    payload: { admin_graphql_api_id: gid, name, status },
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
