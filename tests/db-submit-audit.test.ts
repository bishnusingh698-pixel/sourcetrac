/**
 * Submit-flow fixes from the 2026-10-20 audit, driven through the real routes
 * with a signed checkout session token against real Postgres. Only Shopify's
 * Admin API is stubbed, at `fetch`.
 */
import crypto from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { createSurvey, clearConfigCache, publishSurveyDraft, updateSurvey, getEditorSurvey } from "~/lib/surveys.server";
import { BUCKETS, consumeToken, resetBuckets } from "~/lib/rate-limit.server";
import { clearOrderVerifyCache } from "~/lib/order-verify.server";
import { loader as surveyLoader } from "~/routes/api.survey";
import { action as answersAction } from "~/routes/api.survey-responses";

const prisma = new PrismaClient();
const DOMAIN = "submit-audit-test.myshopify.com";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

function sessionToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    dest: DOMAIN, aud: process.env.SHOPIFY_API_KEY, exp: now + 300, nbf: now - 5, iat: now - 5, jti: crypto.randomUUID(),
  });
  const signature = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "").update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function request(path: string, init: RequestInit = {}, userAgent = UA): Request {
  return new Request(`https://sourcetrac.test${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${sessionToken()}`,
      "Content-Type": "application/json",
      Origin: "https://extensions.shopifycdn.com",
      "User-Agent": userAgent,
    },
  });
}

async function call(handler: (args: { request: Request }) => Promise<Response>, req: Request) {
  try {
    return await handler({ request: req });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

let shopId = "";
let surveyId = "";
let orderSeq = 7_520_000_000_000;
const nextOrder = () => String((orderSeq += 1));

function submit(body: Record<string, unknown>) {
  return call(answersAction, request("/api/survey-responses", { method: "POST", body: JSON.stringify(body) }));
}

beforeAll(async () => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9520001" })).id;
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
  const survey = await createSurvey(shopId, {
    name: "Audit",
    status: "active",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    targeting: { countries: ["DE"], samplePercent: 100 },
    questions: [
      { type: "nps", text: "How likely?", required: false },
      { type: "single_choice", text: "Where?", required: false, options: [{ label: "Instagram" }, { label: "Google" }] },
    ],
  });
  surveyId = survey.id;
});

beforeEach(() => {
  resetBuckets();
  clearConfigCache();
  clearOrderVerifyCache();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.session.deleteMany({ where: { shop: DOMAIN } });
  await prisma.$disconnect();
});

async function questionIds() {
  const editor = await getEditorSurvey(shopId, surveyId);
  return { nps: editor.questions[0]!.id, where: editor.questions[1]!.id, google: editor.questions[1]!.options[1]!.id, version: editor.version };
}

describe("submit flow (2026-10-20 audit)", () => {
  it("does not store an empty answer for a skipped optional question (M8)", async () => {
    const q = await questionIds();
    const orderId = nextOrder();
    const res = await submit({
      surveyId, surveyVersion: q.version, orderId, placement: "thank_you",
      answers: [{ questionId: q.nps }, { questionId: q.where, optionIds: [q.google] }],
    });
    expect(res.status).toBe(200);
    const response = await prisma.response.findFirstOrThrow({ where: { shopId, orderId }, include: { answers: true } });
    expect(response.answers.map((a) => a.questionId)).toEqual([q.where]);
  });

  it("refuses a set where no question has any content (L4)", async () => {
    const q = await questionIds();
    const orderId = nextOrder();
    const res = await submit({ surveyId, surveyVersion: q.version, orderId, placement: "thank_you", answers: [{ questionId: q.nps }] });
    expect(res.status).toBe(400);
    expect(await prisma.response.count({ where: { shopId, orderId } })).toBe(0);
  });

  it("lets a real order through once the shop-wide backstop is drained (H4)", async () => {
    // A lifted token and made-up order ids have emptied the backstop.
    for (let i = 0; i < BUCKETS.responseShop.capacity; i += 1) consumeToken(`answer-shop:${DOMAIN}`, BUCKETS.responseShop);
    await prisma.session.create({
      data: {
        id: `offline_${DOMAIN}`, shop: DOMAIN, state: "s", isOnline: false, scope: "read_orders", accessToken: "x",
        expires: new Date(Date.now() + 3600_000),
      },
    });
    const real = nextOrder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { variables } = JSON.parse(init.body) as { variables: { id: string } };
        const exists = variables.id === `gid://shopify/Order/${real}`;
        return new Response(JSON.stringify({ data: { order: exists ? { id: variables.id } : null } }), { status: 200 });
      }),
    );
    try {
      const q = await questionIds();
      const forged = await submit({ surveyId, surveyVersion: q.version, orderId: nextOrder(), placement: "thank_you", answers: [{ questionId: q.where, optionIds: [q.google] }] });
      expect(forged.status).toBe(429);
      const genuine = await submit({ surveyId, surveyVersion: q.version, orderId: real, placement: "thank_you", answers: [{ questionId: q.where, optionIds: [q.google] }] });
      expect(genuine.status).toBe(200);
      expect(await prisma.response.count({ where: { shopId, orderId: real } })).toBe(1);
    } finally {
      await prisma.session.deleteMany({ where: { shop: DOMAIN } });
    }
  });

  it("excuses an older version only from questions that became required since (L5)", async () => {
    const before = await getEditorSurvey(shopId, surveyId);
    // Publish v+1 with the NPS question made required.
    await updateSurvey(
      shopId,
      surveyId,
      {
        ...before,
        questions: before.questions.map((q, i) => ({ ...q, required: i === 0 })),
      } as unknown as Parameters<typeof updateSurvey>[2],
      before.revision,
    );
    const drafted = await getEditorSurvey(shopId, surveyId);
    await publishSurveyDraft(shopId, surveyId, drafted.revision);
    const q = await questionIds();

    // A buyer on the old version skips the newly required NPS question: excused.
    const stale = await submit({ surveyId, surveyVersion: before.version, orderId: nextOrder(), placement: "thank_you", answers: [{ questionId: q.where, optionIds: [q.google] }] });
    expect(stale.status).toBe(200);
    // "Version 0" does not excuse a question required all along.
    const old = await prisma.question.findFirstOrThrow({ where: { id: q.nps } });
    await prisma.question.update({ where: { id: old.id }, data: { requiredSinceVersion: 0 } });
    const crafted = await submit({ surveyId, surveyVersion: 0, orderId: nextOrder(), placement: "thank_you", answers: [{ questionId: q.where, optionIds: [q.google] }] });
    expect(crafted.status).toBe(400);
    await prisma.question.update({ where: { id: old.id }, data: { requiredSinceVersion: old.requiredSinceVersion } });
  });

  it("serves buyers the survey without the merchant's targeting settings (I2)", async () => {
    const res = await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${nextOrder()}&country=DE`));
    const body = (await res.json()) as { survey: Record<string, unknown> | null };
    expect(body.survey).not.toBeNull();
    expect(body.survey).not.toHaveProperty("targeting");
    expect(body.survey).not.toHaveProperty("responseCount");
  });

  it("treats an empty placement as the Thank-you page (I4)", async () => {
    const res = await call(surveyLoader, request(`/api/survey?placement=&orderId=${nextOrder()}&country=DE`));
    expect(((await res.json()) as { placement: string }).placement).toBe("thank_you");
  });

  it("answers a bot-filtered request with a CORS-readable 410 (I7)", async () => {
    const res = await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${nextOrder()}`, {}, "curl/8.0"));
    expect(res.status).toBe(410);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
