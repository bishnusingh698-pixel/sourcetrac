/**
 * The admin block endpoint, driven the way an admin UI extension calls it:
 * an OpenID Connect ID token signed with the app secret, against real Postgres.
 *
 * The bug this guards against is auth-by-body: the id in the JSON body is only a
 * lookup key, and the shop identity must come from the verified token's `dest`
 * claim. A route that trusted a `shop` field would let any installed app read
 * another shop's answers.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { createSurvey } from "~/lib/surveys.server";
import { upsertShop } from "~/lib/shop.server";
import { action as contextAction, loader as contextLoader } from "~/routes/api.admin-survey-context";

const prisma = new PrismaClient();
const DOMAIN = "admin-context-test.myshopify.com";
const OTHER_DOMAIN = "admin-context-other.myshopify.com";
const ORDER_ID = "7510000000001";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1";

function idToken(dest: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ dest, aud: process.env.SHOPIFY_API_KEY, exp: now + 300, nbf: now - 5, iat: now - 5 });
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function request(body: unknown, init: RequestInit = {}, token = idToken(DOMAIN)): Request {
  return new Request("https://sourcetrac.test/api/admin-survey-context", {
    method: "POST",
    body: JSON.stringify(body),
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "https://admin.shopify.com",
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

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: { in: [DOMAIN, OTHER_DOMAIN] } } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await cleanup();

  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9600001", accessToken: null });
  const survey = await createSurvey(shop.id, {
    name: "How did you hear?",
    status: "active",
    placements: ["thank_you"],
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
        options: [{ label: "Instagram" }, { label: "Google search" }],
      },
    ],
  });

  const question = await prisma.question.findFirstOrThrow({ where: { surveyId: survey.id } });
  const instagram = await prisma.option.findFirstOrThrow({ where: { questionId: question.id, label: "Instagram" } });
  await prisma.response.create({
    data: {
      shopId: shop.id,
      surveyId: survey.id,
      surveyVersion: 1,
      orderId: ORDER_ID,
      placement: "thank_you",
      answers: { create: [{ shopId: shop.id, questionId: question.id, optionIds: JSON.stringify([instagram.id]) }] },
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("admin survey-context endpoint", () => {
  it("answers the preflight with CORS so the block's POST can proceed", async () => {
    const res = await call(contextLoader, new Request("https://sourcetrac.test/api/admin-survey-context", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns the recorded answer for the order named in the body", async () => {
    const res = await call(contextAction, request({ orderId: ORDER_ID }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as { found: boolean; channelLabel: string | null };
    expect(body.found).toBe(true);
    expect(body.channelLabel).toBe("Instagram");
  });

  it("reports no answer instead of erroring when the order has none", async () => {
    const res = await call(contextAction, request({ orderId: "999999999" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      found: false,
      channel: null,
      channelLabel: null,
      surveyName: null,
      submittedAt: null,
    });
  });

  it("rejects a token signed with the wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ dest: DOMAIN, aud: process.env.SHOPIFY_API_KEY, exp: now + 300 });
    const bad = `${header}.${payload}.${Buffer.from("not-a-real-signature").toString("base64url")}`;

    const res = await call(contextAction, request({ orderId: ORDER_ID }, {}, bad));
    expect(res.status).toBe(401);
    // Still CORS-readable: the block must read the 401, not an opaque failure.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("scopes the lookup to the shop in the token, not a body field", async () => {
    // The other shop does not exist here; the token's dest resolves to it, so
    // an order that belongs to the first shop must not leak.
    const res = await call(contextAction, request({ orderId: ORDER_ID }, {}, idToken(OTHER_DOMAIN)));
    expect(res.status).toBe(200);
    expect((await res.json()) as { found: boolean }).toMatchObject({ found: false });
  });
});
