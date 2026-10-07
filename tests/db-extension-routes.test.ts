/**
 * The two extension routes, driven end to end the way the checkout extension
 * calls them: a session token signed with the app secret, a browser
 * User-Agent and a cross-origin Origin, against real Postgres.
 *
 * Both bugs these pin passed every other test, because the extension tests stub
 * `fetch` with the shape the extension expects rather than what the route sent:
 * - The body was the serialised `data()` wrapper,
 *   `{"type":"DataWithResponseInit","data":{...}}`, so the extension read
 *   `enabled` as undefined and hid the survey on every order.
 * - `/api/responses` had no loader, so the browser's OPTIONS preflight got a
 *   400 without CORS headers and no answer could ever be sent.
 */
import crypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { toResponse } from "~/lib/http.server";
import { upsertShop } from "~/lib/shop.server";
import { action as submitAction, loader as submitLoader } from "~/routes/api.responses";
import { loader as configLoader } from "~/routes/api.survey-config";

const prisma = new PrismaClient();
const DOMAIN = "extension-routes-test.myshopify.com";
const ORDER_GID = "gid://shopify/OrderIdentity/7310000000001";
const ORDER_ID = "7310000000001";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

function sessionToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  // The claims a checkout session token carries: `dest` is the bare shop domain.
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

/** Call a route the way React Router does: a thrown Response is the answer. */
async function call(handler: (args: { request: Request }) => Promise<Response>, req: Request) {
  try {
    return await handler({ request: req });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function cleanup() {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  }
  await cleanup();
  await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9300001", accessToken: null });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("extension routes, as the checkout extension calls them", () => {
  it("answers the config preflight with CORS", async () => {
    const res = await call(configLoader, request(`/api/survey-config?orderId=1`, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers the submit preflight with CORS", async () => {
    const res = await call(submitLoader, request("/api/responses", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
  });

  it("serves the config at the top level of the body, where the extension reads it", async () => {
    const res = await call(
      configLoader,
      request(`/api/survey-config?orderId=${encodeURIComponent(ORDER_GID)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBeUndefined();
    expect(body.enabled).toBe(true);
    expect(body.alreadyAnswered).toBe(false);
    expect(body.orderId).toBe(ORDER_ID);
    expect(Array.isArray(body.options) && body.options.length).toBeGreaterThan(0);
  });

  it("stores a submitted answer under the numeric order id", async () => {
    const res = await call(
      submitAction,
      request("/api/responses", {
        method: "POST",
        body: JSON.stringify({ orderId: ORDER_GID, channel: "instagram", otherText: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true, counted: true });

    const rows = await prisma.surveyResponse.findMany({ where: { shop: { shopDomain: DOMAIN } } });
    expect(rows.map((row) => [row.orderId, row.channel])).toEqual([[ORDER_ID, "instagram"]]);
  });

  it("hides the survey on the other page once the order has answered", async () => {
    const res = await call(
      configLoader,
      request(`/api/survey-config?orderId=${encodeURIComponent(`gid://shopify/Order/${ORDER_ID}`)}`),
    );
    expect(((await res.json()) as { alreadyAnswered?: boolean }).alreadyAnswered).toBe(true);
  });

  it("serves the survey whatever plan we last recorded", async () => {
    // A trial store was recorded as unsupported, and the routes hid the survey
    // and dropped answers there. Shopify decides where the block renders.
    await prisma.shop.update({ where: { shopDomain: DOMAIN }, data: { checkoutSupported: false } });
    try {
      const res = await call(configLoader, request(`/api/survey-config?orderId=7310000000002`));
      expect(((await res.json()) as { enabled?: boolean }).enabled).toBe(true);
    } finally {
      await prisma.shop.update({ where: { shopDomain: DOMAIN }, data: { checkoutSupported: true } });
    }
  });

  it("keeps a rejected order id CORS-readable", async () => {
    const res = await call(configLoader, request(`/api/survey-config?orderId=abc`));
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("toResponse", () => {
  it("unwraps data() and keeps its status and headers", async () => {
    const { data } = await import("react-router");
    const res = toResponse(data({ a: 1 }, { status: 201, headers: { "X-Test": "1" } }));
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Test")).toBe("1");
    expect(await res.json()).toEqual({ a: 1 });
  });
});
