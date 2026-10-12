/**
 * The v2 extension routes, driven end to end the way the multi-question
 * extension calls them: a session token signed with the app secret, a browser
 * User-Agent and a cross-origin Origin, against real Postgres.
 *
 * These pin the things a bundle test cannot see, because it stubs `fetch`:
 * that the compiled config is served at the top level, that an answer set is
 * stored across Response + Answer rows, that a duplicate is a success, and that
 * the routes stay CORS-readable on every exit.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { createSurvey, clearConfigCache } from "~/lib/surveys.server";
import { loader as surveyLoader } from "~/routes/api.survey";
import { action as answersAction, loader as answersLoader } from "~/routes/api.survey-responses";

const prisma = new PrismaClient();
const DOMAIN = "survey-v2-routes-test.myshopify.com";
const ORDER_GID = "gid://shopify/OrderIdentity/7410000000001";
const ORDER_ID = "7410000000001";
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

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://sourcetrac.test${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${sessionToken()}`,
      "Content-Type": "application/json",
      Origin: "https://extensions.shopifycdn.com",
      "User-Agent": UA,
      ...(init.headers as Record<string, string> | undefined),
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

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await cleanup();
  clearConfigCache();
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9400001", accessToken: null });
  shopId = shop.id;

  const survey = await createSurvey(shopId, {
    name: "How did you hear?",
    status: "active",
    placements: ["thank_you", "order_status"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        type: "single_choice",
        text: "How did you hear about us?",
        required: true,
        randomizeOptions: false,
        allowOther: true,
        options: [
          { label: "Instagram" },
          { label: "Google search" },
          { label: "Friend or family" },
        ],
      },
    ],
  });
  surveyId = survey.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("v2 survey routes, as the multi-question extension calls them", () => {
  it("answers the config preflight with CORS", async () => {
    const res = await call(surveyLoader, request("/api/survey?placement=thank_you", { method: "OPTIONS" }));
    // The loader is GET-only; the library answers OPTIONS itself with 204.
    expect([204, 405]).toContain(res.status);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves the compiled survey at the top level of the body", async () => {
    const res = await call(
      surveyLoader,
      request(`/api/survey?placement=thank_you&orderId=${encodeURIComponent(ORDER_GID)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBeUndefined();
    expect(body.enabled).toBe(true);
    expect(body.alreadyAnswered).toBe(false);
    expect(body.orderId).toBe(ORDER_ID);
    const survey = body.survey as { questions: Array<{ text: string; options: unknown[] }> };
    expect(survey.questions[0]?.text).toBe("How did you hear about us?");
    expect(survey.questions[0]?.options.length).toBeGreaterThan(0);
  });

  it("stores a submitted answer set across Response and Answer rows", async () => {
    const config = (await (
      await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${encodeURIComponent(ORDER_GID)}`))
    ).json()) as { survey: { questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> } };
    const question = config.survey.questions[0]!;
    const instagram = question.options.find((o) => o.label === "Instagram")!;

    const res = await call(
      answersAction,
      request("/api/survey-responses", {
        method: "POST",
        body: JSON.stringify({
          surveyId,
          orderId: ORDER_GID,
          placement: "thank_you",
          answers: [{ questionId: question.id, optionIds: [instagram.id] }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true, counted: true });

    const rows = await prisma.response.findMany({
      where: { shopId },
      include: { answers: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderId).toBe(ORDER_ID);
    expect(rows[0]?.answers).toHaveLength(1);
    expect(JSON.parse(rows[0]!.answers[0]!.optionIds)).toEqual([instagram.id]);
  });

  it("treats a duplicate submission as a success and writes no second row", async () => {
    const config = (await (
      await call(surveyLoader, request(`/api/survey?placement=thank_you&orderId=${encodeURIComponent(ORDER_GID)}`))
    ).json()) as { survey: { questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> } };
    const question = config.survey.questions[0]!;
    const google = question.options.find((o) => o.label === "Google search")!;

    const res = await call(
      answersAction,
      request("/api/survey-responses", {
        method: "POST",
        body: JSON.stringify({
          surveyId,
          orderId: ORDER_GID,
          placement: "order_status",
          answers: [{ questionId: question.id, optionIds: [google.id] }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, counted: true });

    const count = await prisma.response.count({ where: { shopId, orderId: ORDER_ID } });
    expect(count).toBe(1);
  });

  it("hides the survey on the other page once the order has answered", async () => {
    const res = await call(
      surveyLoader,
      request(`/api/survey?placement=order_status&orderId=${encodeURIComponent(`gid://shopify/Order/${ORDER_ID}`)}`),
    );
    expect(((await res.json()) as { alreadyAnswered?: boolean }).alreadyAnswered).toBe(true);
  });

  it("rejects an answer set that breaks the survey's own rules", async () => {
    const res = await call(
      answersAction,
      request("/api/survey-responses", {
        method: "POST",
        body: JSON.stringify({
          surveyId,
          orderId: "7410000000009",
          placement: "thank_you",
          answers: [{ questionId: "does-not-exist", optionIds: ["nope"] }],
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const count = await prisma.response.count({ where: { shopId, orderId: "7410000000009" } });
    expect(count).toBe(0);
  });

  it("answers the submit preflight with CORS", async () => {
    const res = await call(answersLoader, request("/api/survey-responses", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
