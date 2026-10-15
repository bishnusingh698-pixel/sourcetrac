/**
 * Install/auth odds and ends (AUTH flow), against real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "~/db.server";
import { hasAnyAnswerForOrder } from "~/lib/answers.server";
import { safeEqual } from "~/lib/crypto.server";
import { submitResponse } from "~/lib/responses.server";
import { upsertShop } from "~/lib/shop.server";
import { sessionStorage } from "~/session-storage.server";

const SHOP = "auth-flow-test.myshopify.com";

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

afterAll(async () => {
  await db.session.deleteMany({ where: { shop: SHOP } });
  await db.shop.deleteMany({ where: { shopDomain: SHOP } });
});

describe("auth flow", () => {
  it("seals a legacy plain-text session token when it is first read (L3)", async () => {
    await db.session.create({ data: { id: `legacy_${SHOP}`, shop: SHOP, state: "s", isOnline: false, accessToken: "shpat_plain" } });
    const loaded = await sessionStorage.loadSession(`legacy_${SHOP}`);
    expect(loaded?.accessToken).toBe("shpat_plain");
    const raw = await db.session.findUniqueOrThrow({ where: { id: `legacy_${SHOP}` } });
    expect(raw.accessToken?.startsWith("enc:v1:")).toBe(true);
  });

  it("compares secrets without depending on their length (I8)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("treats an order answered on either path as answered on both (I17)", async () => {
    const shop = await upsertShop({ shopDomain: SHOP, shopId: "gid://shopify/Shop/970000", accessToken: null });
    const survey = await db.survey.create({ data: { shopId: shop.id, name: "S", placements: "[]" } });
    await db.response.create({ data: { shopId: shop.id, surveyId: survey.id, surveyVersion: 1, orderId: "970001", placement: "thank_you" } });
    const legacy = await submitResponse({ shopId: shop.id, orderId: "970001", channel: "google", otherText: null, locale: null, plan: "growth" });
    expect(legacy.outcome).toBe("duplicate");
    expect(await db.surveyResponse.count({ where: { shopId: shop.id } })).toBe(0);

    await db.surveyResponse.create({ data: { shopId: shop.id, orderId: "970002", channel: "google" } });
    expect(await hasAnyAnswerForOrder(shop.id, "970002")).toBe(true);
  });
});
