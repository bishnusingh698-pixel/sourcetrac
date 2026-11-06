/**
 * Shopify counts a webhook delivery as failed when it is not answered within
 * five seconds, and retries it (https://shopify.dev/docs/apps/build/webhooks/troubleshoot).
 * The route must answer inside that budget even when the work behind it is
 * slow (Shopify's Admin API stalling during a billing notice, Neon waking):
 * it replies 503 so Shopify retries, and the work it started still finishes
 * and is recorded, so the retry finds it done.
 */
import { createHmac, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { seedOfflineSession } from "./helpers/admin-request";
import { action, setWebhookReplyBudgetForTests } from "~/routes/webhooks";

const prisma = new PrismaClient();
const DOMAIN = "webhook-budget-test.myshopify.com";
const SUB = "gid://shopify/AppSubscription/4400";

function signed(topic: string, body: Record<string, unknown>, webhookId: string): Request {
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

let release: () => void = () => undefined;

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "whbudget-" } } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.shop.create({ data: { shopId: "gid://shopify/Shop/944000", shopDomain: DOMAIN, installState: "installed" } });
  await seedOfflineSession(DOMAIN);
  // Shopify's Admin API answers only when the test lets it.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(
                JSON.stringify({ data: { node: { id: SUB, name: "SourceTrac — Growth", status: "ACTIVE", test: false, trialDays: 0, createdAt: new Date().toISOString() } } }),
                { status: 200 },
              ),
            );
        }),
    ),
  );
  setWebhookReplyBudgetForTests(300);
});

afterEach(() => {
  setWebhookReplyBudgetForTests(null);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({ where: { webhookId: { startsWith: "whbudget-" } } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("webhook reply budget", () => {
  it("answers 503 in time when the work is slow, and still finishes the work", async () => {
    const id = `whbudget-${randomUUID()}`;
    const started = Date.now();
    const res = await action({
      request: signed("app_subscriptions/update", { app_subscription: { admin_graphql_api_id: SUB, name: "SourceTrac — Growth", status: "ACTIVE" } }, id),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.status).toBe(503);

    // Shopify answers late; the work completes and is recorded.
    release();
    await vi.waitFor(async () => {
      const event = await prisma.webhookEvent.findUnique({ where: { webhookId: id } });
      expect(event?.processedAt).not.toBeNull();
    });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN } });
    expect(shop.plan).toBe("growth");

    // Shopify's retry finds the delivery done.
    const retry = await action({
      request: signed("app_subscriptions/update", { app_subscription: { admin_graphql_api_id: SUB, name: "SourceTrac — Growth", status: "ACTIVE" } }, id),
    });
    expect(retry.status).toBe(200);
  });
});
