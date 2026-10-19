/**
 * The buyer submit path (/api/survey-responses -> submitAnswers), against real
 * Postgres and the real route. Each case is a way a buyer's answer used to be
 * refused and lost, or stored wrongly.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { resetBuckets } from "~/lib/rate-limit.server";
import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, createSurvey } from "~/lib/surveys.server";
import { action as submitAction } from "~/routes/api.survey-responses";

const prisma = new PrismaClient();
const DOMAIN = "submit-flow-test.myshopify.com";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

function sessionToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    dest: DOMAIN,
    aud: process.env.SHOPIFY_API_KEY,
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    jti: crypto.randomUUID(),
  });
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function submit(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("https://sourcetrac.test/api/survey-responses", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${sessionToken()}`,
      "Content-Type": "application/json",
      Origin: "https://extensions.shopifycdn.com",
      "User-Agent": UA,
    },
  });
  let res: Response;
  try {
    res = await submitAction({ request: req });
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    res = thrown;
  }
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let shopId = "";
let surveyId = "";
let q1 = "";
let q2 = "";
let instagram = "";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
});

beforeEach(async () => {
  resetBuckets();
  clearConfigCache();
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9700001", accessToken: null });
  shopId = shop.id;
  // Several live surveys, targeting rules and Shopify actions are paid features.
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
  const survey = await createSurvey(shopId, {
    name: "Submit",
    status: "active",
    placements: ["thank_you", "order_status"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      { type: "single_choice", text: "How did you hear about us?", required: true, options: [{ label: "Instagram" }, { label: "Google" }] },
      { type: "satisfaction_5", text: "How satisfied are you?", required: false },
    ],
  });
  surveyId = survey.id;
  const questions = await prisma.question.findMany({ where: { surveyId }, orderBy: { position: "asc" }, include: { options: true } });
  q1 = questions[0]!.id;
  q2 = questions[1]!.id;
  instagram = questions[0]!.options.find((o) => o.label === "Instagram")!.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const base = (orderId: string, answers: unknown[]) => ({ surveyId, orderId, placement: "thank_you", answers });

describe("buyer submit", () => {
  it("is not blocked by a removed (archived) required question (C2)", async () => {
    await prisma.question.update({ where: { id: q2 }, data: { archived: true, required: true } });
    const res = await submit(base("9710000000001", [{ questionId: q1, optionIds: [instagram] }]));
    expect(res.status).toBe(200);
    expect(await prisma.response.count({ where: { shopId } })).toBe(1);
  });

  it("validates against the published survey, not an unpublished draft (C3)", async () => {
    // A draft that adds a required question and drops Instagram.
    const draft = {
      name: "Submit",
      placements: ["thank_you"],
      layout: "all",
      title: "Quick question",
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks!",
      questions: [{ type: "text", text: "New required", required: true }],
    };
    await prisma.survey.update({ where: { id: surveyId }, data: { draft: JSON.stringify(draft) } });
    const res = await submit(base("9710000000002", [{ questionId: q1, optionIds: [instagram] }]));
    expect(res.status).toBe(200);
  });

  it("accepts an answer from an older published version that lacks a new required question (M6)", async () => {
    const res = await submit({
      ...base("9710000000003", [{ questionId: q1, optionIds: [instagram] }, { questionId: "gone-question", textValue: "x" }]),
      surveyVersion: 0,
    });
    await prisma.question.update({ where: { id: q2 }, data: { required: true } });
    expect(res.status).toBe(200);
    const stale = await submit({ ...base("9710000000004", [{ questionId: q1, optionIds: [instagram] }]), surveyVersion: 0 });
    expect(stale.status).toBe(200);
    const current = await submit({ ...base("9710000000005", [{ questionId: q1, optionIds: [instagram] }]), surveyVersion: 1 });
    expect(current.status).toBe(400);
  });

  it("accepts an option archived after the buyer loaded the survey (M6)", async () => {
    await prisma.option.update({ where: { id: instagram }, data: { archived: true } });
    const res = await submit(base("9710000000006", [{ questionId: q1, optionIds: [instagram] }]));
    expect(res.status).toBe(200);
  });

  it("refuses a question answered twice and stores only typed fields (M5)", async () => {
    const twice = await submit(
      base("9710000000007", [
        { questionId: q1, optionIds: ["junk"] },
        { questionId: q1, optionIds: [instagram] },
      ]),
    );
    expect(twice.status).toBe(400);

    const ok = await submit(
      base("9710000000008", [
        { questionId: q1, optionIds: [instagram], numberValue: 7, textValue: "junk", otherText: "junk" },
        { questionId: q2, optionIds: ["satisfied"] },
      ]),
    );
    expect(ok.status).toBe(200);
    const answers = await prisma.answer.findMany({ where: { shopId }, orderBy: { questionId: "asc" } });
    const choice = answers.find((a) => a.questionId === q1)!;
    expect(choice.numberValue).toBeNull();
    expect(choice.textValue).toBeNull();
    expect(choice.otherText).toBeNull();
    // H7: satisfaction stores its canonical 1-5 value.
    expect(answers.find((a) => a.questionId === q2)!.numberValue).toBe(4);
  });

  it("stores one answer set per order across surveys (M4)", async () => {
    const other = await createSurvey(shopId, {
      name: "Second",
      status: "active",
      layout: "all",
      title: "Another",
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks!",
      questions: [{ type: "yes_no", text: "Again?" }],
    });
    const otherQ = await prisma.question.findFirstOrThrow({ where: { surveyId: other.id } });
    const orderId = "9710000000009";
    const results = await Promise.all([
      submit(base(orderId, [{ questionId: q1, optionIds: [instagram] }])),
      submit({ surveyId: other.id, orderId, placement: "thank_you", answers: [{ questionId: otherQ.id, numberValue: 1 }] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.response.count({ where: { shopId, orderId } })).toBe(1);
    const counts = await prisma.survey.findMany({ where: { shopId }, select: { responseCount: true } });
    expect(counts.reduce((sum, row) => sum + row.responseCount, 0)).toBe(1);
  });

  it("refuses a checkout submission without an order id (M7)", async () => {
    const res = await submit({ surveyId, placement: "thank_you", answers: [{ questionId: q1, optionIds: [instagram] }] });
    expect(res.status).toBe(400);
  });

  it("refuses a draft survey and a placement the survey is not on (L18)", async () => {
    await prisma.survey.update({ where: { id: surveyId }, data: { status: "draft" } });
    expect((await submit(base("9710000000010", [{ questionId: q1, optionIds: [instagram] }]))).status).toBe(400);
    await prisma.survey.update({ where: { id: surveyId }, data: { status: "active", placements: '["order_status"]' } });
    expect((await submit(base("9710000000011", [{ questionId: q1, optionIds: [instagram] }]))).status).toBe(400);
  });

  it("drops an answer left on a question hidden by show-if instead of refusing the set (M1)", async () => {
    await prisma.question.update({
      where: { id: q2 },
      data: { showIf: JSON.stringify({ questionId: q1, optionIds: ["never-chosen"] }) },
    });
    const res = await submit(
      base("9710000000012", [
        { questionId: q1, optionIds: [instagram] },
        { questionId: q2, optionIds: ["satisfied"] },
      ]),
    );
    expect(res.status).toBe(200);
    expect(await prisma.answer.count({ where: { shopId, questionId: q2 } })).toBe(0);
  });

  it("does not let failed attempts burn the per-token cap, and reserves before any await (M3)", async () => {
    const { releaseTokenSubmission, reserveTokenSubmission } = await import("~/lib/rate-limit.server");
    const key = "token:test:jti";
    const exp = Date.now() + 60_000;
    // Two attempts that stored nothing give their slot back.
    reserveTokenSubmission(key, exp);
    releaseTokenSubmission(key);
    reserveTokenSubmission(key, exp);
    releaseTokenSubmission(key);
    // Two stored answers use the allowance; a third is refused at once, even
    // while the first two are still in flight.
    reserveTokenSubmission(key, exp);
    reserveTokenSubmission(key, exp);
    expect(() => reserveTokenSubmission(key, exp)).toThrow();
  });
});
