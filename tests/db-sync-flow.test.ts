/**
 * Shopify write-back (SYNC flow), against real Postgres with only the network
 * call to Shopify stubbed at `fetch`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { createSurvey } from "~/lib/surveys.server";
import { enqueueSync, processPendingSync } from "~/lib/sync.server";
import { processWebhook } from "~/lib/webhooks.server";

const prisma = new PrismaClient();
const DOMAIN = "sync-flow-test.myshopify.com";
let shopId = "";
let responseId = "";

type Call = { query: string; variables: Record<string, unknown> };

function stubShopify(answer: (call: Call) => unknown = () => ({})): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const call = JSON.parse(init.body) as Call;
      calls.push(call);
      return new Response(JSON.stringify({ data: answer(call) }), { status: 200 });
    }),
  );
  return calls;
}

async function seed(syncOptions: Record<string, unknown>, otherText: string | null = null) {
  const survey = await createSurvey(shopId, {
    name: "Sync",
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: "Q",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    syncOptions,
    questions: [{ type: "single_choice", text: "Where?", allowOther: true, options: [{ label: "Instagram Ads" }, { label: "Google" }] }],
  });
  const question = survey.questions[0]!;
  const optionId = otherText ? "other" : question.options[0]!.id;
  const response = await prisma.response.create({
    data: {
      shopId,
      surveyId: survey.id,
      surveyVersion: 1,
      orderId: "940001",
      placement: "thank_you",
      answers: { create: { shopId, questionId: question.id, optionIds: JSON.stringify([optionId]), otherText } },
    },
  });
  responseId = response.id;
  await enqueueSync(shopId, responseId, syncOptions);
}

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/940000", accessToken: "shpat_test" });
  shopId = shop.id;
  await prisma.session.create({
    data: { id: `offline_${DOMAIN}`, shop: DOMAIN, state: "s", isOnline: false, scope: "read_orders,write_orders", accessToken: "x" },
  });
  await prisma.orderCache.create({
    data: {
      shopId, orderId: "940001", currency: "USD", totalPrice: "10.00", financialStatus: "paid",
      isTest: false, isCancelled: false, createdAtShop: new Date(), updatedAtShop: new Date(),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.$disconnect();
});

describe("sync", () => {
  it("fires the Flow trigger once when two drains race (H16, L50)", async () => {
    await seed({ flowTrigger: true });
    await enqueueSync(shopId, responseId, { flowTrigger: true });
    const calls = stubShopify(() => ({ flowTriggerReceive: { userErrors: [] } }));
    await Promise.all([processPendingSync(shopId), processPendingSync(shopId)]);
    expect(calls.filter((c) => c.query.includes("flowTriggerReceive"))).toHaveLength(1);
    expect(await prisma.pendingSync.count({ where: { shopId } })).toBe(0);
  });

  it("sends a readable channel key to Flow, not a row id (L45)", async () => {
    await seed({ flowTrigger: true });
    const calls = stubShopify(() => ({ flowTriggerReceive: { userErrors: [] } }));
    await processPendingSync(shopId);
    const payload = calls[0]!.variables.payload as Record<string, unknown>;
    expect(payload.Channel).toBe("instagram-ads");
    expect(payload["Channel label"]).toBe("Instagram Ads");
  });

  it("never puts a buyer's free text into a tag (L43, L44)", async () => {
    await seed({ orderTags: ["sourcetrac:{channel}"] }, "wholesale:approved");
    const calls = stubShopify(() => ({ tagsAdd: { userErrors: [] } }));
    await processPendingSync(shopId);
    expect(calls[0]!.variables.tags).toEqual(["sourcetrac:other"]);
  });

  it("retries a customer write whose order lookup failed instead of dropping it (M17)", async () => {
    await prisma.session.updateMany({ where: { shop: DOMAIN }, data: { scope: "read_orders,write_customers" } });
    await seed({ customerTags: ["vip"] });
    stubShopify(() => ({ order: null }));
    await processPendingSync(shopId);
    const row = await prisma.pendingSync.findFirstOrThrow({ where: { shopId } });
    expect(row.attempts).toBe(1);
  });

  it("stores the granted scopes from app/scopes_update (H17)", async () => {
    await processWebhook({
      topic: "app/scopes_update",
      shopDomain: DOMAIN,
      payload: { current: ["read_orders", "write_orders", "write_customers"] },
      accessToken: null,
    });
    const session = await prisma.session.findFirstOrThrow({ where: { shop: DOMAIN } });
    expect(session.scope).toBe("read_orders,write_orders,write_customers");
  });
});
