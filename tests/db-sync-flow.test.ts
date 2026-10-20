/**
 * Shopify write-back (SYNC flow), against real Postgres with only the network
 * call to Shopify stubbed at `fetch`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { submitAnswers } from "~/lib/answers.server";
import { upsertShop } from "~/lib/shop.server";
import { createSurvey, getSurveyRow, rowToEditor } from "~/lib/surveys.server";
import { enqueueSync, processPendingSync } from "~/lib/sync.server";
import { templateSurveyInput } from "~/lib/template-survey";
import { templateById } from "@shared/templates";
import { regionPackFor } from "@shared/templates/packs";
import { stableQuestionId } from "@shared/templates/resolve";
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
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/940000" });
  shopId = shop.id;
  // Several live surveys, targeting rules and Shopify actions are paid features.
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
  await prisma.session.create({
    // Expiring, as every offline session now is: one with no expiry is a
    // legacy token and is exchanged on load (tests/db-token-migration.test.ts).
    data: {
      id: `offline_${DOMAIN}`, shop: DOMAIN, state: "s", isOnline: false, scope: "read_orders,write_orders", accessToken: "x",
      expires: new Date(Date.now() + 3600_000),
    },
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
    expect(await prisma.pendingSync.count({ where: { shopId, completedAt: null } })).toBe(0);
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

  it("fires Flow as soon as the order arrives, without an admin visit (review)", async () => {
    await prisma.orderCache.deleteMany({ where: { shopId } });
    await seed({ flowTrigger: true });
    const calls = stubShopify(() => ({ flowTriggerReceive: { userErrors: [] } }));
    await processPendingSync(shopId);
    expect(calls.filter((c) => c.query.includes("flowTriggerReceive"))).toHaveLength(0);

    await processWebhook({
      topic: "orders/create",
      shopDomain: DOMAIN,
      payload: {
        id: 940001, currency: "USD", current_total_price: "10.00", financial_status: "paid", test: false,
        cancelled_at: null, created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T09:00:00Z",
      },
      accessToken: null,
    });
    for (let i = 0; i < 100 && calls.filter((c) => c.query.includes("flowTriggerReceive")).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(calls.filter((c) => c.query.includes("flowTriggerReceive"))).toHaveLength(1);
  });

  it("queues sync work from a real submit, which passes syncOptions as stored JSON (C1)", async () => {
    const survey = await createSurvey(shopId, {
      name: "Submit sync",
      status: "active",
      placements: ["thank_you"],
      layout: "all",
      title: "Q",
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks!",
      syncOptions: { orderTags: ["source:{channel}"], flowTrigger: true },
      questions: [{ type: "single_choice", text: "Where?", options: [{ label: "Google" }, { label: "Friend" }] }],
    });
    const row = (await getSurveyRow(shopId, survey.id))!;
    const editor = rowToEditor(row, { view: "published" });
    const calls = stubShopify(() => ({ tagsAdd: { userErrors: [] }, flowTriggerReceive: { userErrors: [] } }));
    const result = await submitAnswers({
      shopId,
      surveyId: survey.id,
      surveyVersion: row.version,
      currentVersion: row.version,
      orderId: "940001",
      placement: "thank_you",
      locale: "en",
      plan: "scale",
      syncOptions: row.syncOptions,
      answers: [{ questionId: editor.questions[0]!.id, optionIds: [editor.questions[0]!.options[0]!.id] }],
      definition: { id: editor.id, name: editor.name, title: editor.title, layout: editor.layout, questions: editor.questions },
    } as Parameters<typeof submitAnswers>[0]);
    if (result.outcome !== "created") throw new Error(`expected a stored answer, got ${result.outcome}`);
    const kinds = (await prisma.pendingSync.findMany({ where: { shopId, responseId: result.id } })).map((r) => r.kind);
    expect(kinds.sort()).toEqual(["flow", "tags"]);
    // The order is known, so the inline drain runs and both writes go out.
    for (let i = 0; i < 100 && calls.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.map((c) => (c.query.includes("tagsAdd") ? "tags" : "flow")).sort()).toEqual(["flow", "tags"]);
  });

  it("never re-queues work that already ran when the same answer is resubmitted (H2)", async () => {
    await seed({ flowTrigger: true });
    const calls = stubShopify(() => ({ flowTriggerReceive: { userErrors: [] } }));
    await processPendingSync(shopId);
    expect(calls).toHaveLength(1);
    // A retried POST lands as a duplicate and runs the follow-ups again.
    await enqueueSync(shopId, responseId, { flowTrigger: true });
    await processPendingSync(shopId);
    expect(calls).toHaveLength(1);
  });

  it("leaves a row another drainer holds alone, even once it is due (H3)", async () => {
    await seed({ flowTrigger: true });
    await prisma.pendingSync.updateMany({ where: { shopId }, data: { leaseUntil: new Date(Date.now() + 60_000) } });
    const calls = stubShopify(() => ({ flowTriggerReceive: { userErrors: [] } }));
    await processPendingSync(shopId);
    expect(calls).toHaveLength(0);
  });

  it("keeps queued work while a Scale plan is frozen instead of deleting it (M6)", async () => {
    await seed({ orderTags: ["vip"] });
    await prisma.shop.update({ where: { id: shopId }, data: { planStatus: "frozen" } });
    const calls = stubShopify(() => ({ tagsAdd: { userErrors: [] } }));
    await processPendingSync(shopId);
    expect(calls).toHaveLength(0);
    const row = await prisma.pendingSync.findFirstOrThrow({ where: { shopId } });
    expect(row.completedAt).toBeNull();
    // Waiting on the bill is not a failed attempt: it would give up after hours.
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not resend Flow after a 5xx that may have run it (M7)", async () => {
    await seed({ flowTrigger: true });
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        count += 1;
        return new Response("upstream", { status: 502 });
      }),
    );
    await processPendingSync(shopId);
    await prisma.pendingSync.updateMany({ where: { shopId }, data: { nextAttemptAt: new Date(0) } });
    await processPendingSync(shopId);
    expect(count).toBe(1);
    const row = await prisma.pendingSync.findFirstOrThrow({ where: { shopId } });
    expect(row.completedAt).not.toBeNull();
  });

  it("tags an option the merchant added to a template survey by its label, not its row id (L43)", async () => {
    await prisma.session.updateMany({ where: { shop: DOMAIN }, data: { scope: "read_orders,write_orders" } });
    const built = templateSurveyInput({
      template: templateById("channel-compass")!,
      locale: "en",
      region: regionPackFor("US"),
      plan: "scale",
    });
    if (!built.ok) throw new Error("expected a usable template");
    const survey = await createSurvey(shopId, { ...built.input, syncOptions: { presets: ["channel_order_tag"] } });
    const question = await prisma.question.findFirstOrThrow({
      where: { surveyId: survey.id, templateKey: stableQuestionId("channel-compass", "q_channel") },
    });
    const added = await prisma.option.create({ data: { questionId: question.id, position: 99, label: "Snapchat Ads" } });
    const response = await prisma.response.create({
      data: {
        shopId, surveyId: survey.id, surveyVersion: 1, orderId: "940001", placement: "thank_you",
        answers: { create: { shopId, questionId: question.id, optionIds: JSON.stringify([added.id]) } },
      },
    });
    await enqueueSync(shopId, response.id, { presets: ["channel_order_tag"] });
    const calls = stubShopify(() => ({ tagsAdd: { userErrors: [] } }));
    await processPendingSync(shopId);
    expect(calls[0]!.variables.tags).toEqual(["found:snapchat-ads"]);
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
