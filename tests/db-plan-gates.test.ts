/**
 * Plan gates on surveys, against real Postgres: how many surveys can be live,
 * which settings each plan may switch on, grandfathering after a downgrade, and
 * what buyers are served when a shop has more live surveys than its plan.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import {
  clearConfigCache,
  createSurvey,
  getCompiledConfig,
  getEditorSurvey,
  liveSurveyUsage,
  setSurveyStatus,
  updateSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";
import { ValidationError } from "~/lib/errors";

const prisma = new PrismaClient();
const DOMAIN = "plan-gates-test.myshopify.com";
let shopId = "";

function input(over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name: "Gate",
    status: "draft",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      { type: "single_choice", text: "Where?", required: true, options: [{ label: "Instagram" }, { label: "Google" }] },
    ],
    ...over,
  };
}

async function setPlan(plan: "free" | "growth" | "scale") {
  await prisma.shop.update({ where: { id: shopId }, data: { plan, planStatus: "active" } });
  clearConfigCache();
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return String(error.fields.code ?? error.code);
    throw error;
  }
}

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9810001", accessToken: null });
  shopId = shop.id;
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("live survey limit", () => {
  it("allows one live survey on Free, ten on Growth and any number on Scale", async () => {
    await createSurvey(shopId, input({ status: "active" }));
    const second = await createSurvey(shopId, input({ name: "Second" }));
    expect(await codeOf(setSurveyStatus(shopId, second.id, "active"))).toBe("plan_live_limit");

    await setPlan("growth");
    await setSurveyStatus(shopId, second.id, "active");
    for (let i = 3; i <= 10; i += 1) await createSurvey(shopId, input({ name: `S${i}`, status: "active" }));
    const eleventh = await createSurvey(shopId, input({ name: "Eleventh" }));
    expect(await codeOf(setSurveyStatus(shopId, eleventh.id, "active"))).toBe("plan_live_limit");
    expect(await liveSurveyUsage(shopId)).toEqual({ live: 10, limit: 10, plan: "growth" });

    await setPlan("scale");
    await setSurveyStatus(shopId, eleventh.id, "active");
    await createSurvey(shopId, input({ name: "Twelfth", status: "active" }));
    expect(await liveSurveyUsage(shopId)).toEqual({ live: 12, limit: null, plan: "scale" });
    expect((await getCompiledConfig(shopId)).surveys).toHaveLength(12);
  });

  it("serves only the plan's share of live surveys after a downgrade, without pausing any", async () => {
    await setPlan("scale");
    for (const name of ["A", "B", "C"]) await createSurvey(shopId, input({ name, status: "active" }));
    expect((await getCompiledConfig(shopId)).surveys).toHaveLength(3);

    await setPlan("free");
    const config = await getCompiledConfig(shopId);
    expect(config.surveys).toHaveLength(1);
    expect(await prisma.survey.count({ where: { shopId, status: "active" } })).toBe(3);
    expect(await liveSurveyUsage(shopId)).toEqual({ live: 3, limit: 1, plan: "free" });
  });
});

describe("paid settings", () => {
  it("refuses Growth targeting and Scale actions on Free, and keeps customer type free", async () => {
    expect(await codeOf(createSurvey(shopId, input({ targeting: { customerType: "first_order" } })))).toBeNull();
    expect(await codeOf(createSurvey(shopId, input({ targeting: { minValue: 50 } })))).toBe("plan_advanced_targeting");
    expect(await codeOf(createSurvey(shopId, input({ syncOptions: { orderTags: ["survey:{channel}"] } })))).toBe(
      "plan_shopify_actions",
    );
    expect(await codeOf(createSurvey(shopId, input({ learnAndStop: true })))).toBe("plan_auto_stop");
  });

  it("allows targeting on Growth but still needs Scale for actions", async () => {
    await setPlan("growth");
    expect(await codeOf(createSurvey(shopId, input({ targeting: { countries: ["US"] } })))).toBeNull();
    expect(await codeOf(createSurvey(shopId, input({ syncOptions: { flowTrigger: true } })))).toBe("plan_shopify_actions");
  });

  it("keeps a setting a survey already had after a downgrade, but refuses a new one", async () => {
    await setPlan("growth");
    const survey = await createSurvey(shopId, input({ targeting: { minValue: 50 } }));
    await setPlan("free");

    const editor = await getEditorSurvey(shopId, survey.id);
    const unchanged = { ...editor, title: "Renamed", questions: editor.questions.map((q) => ({ ...q })) };
    expect(await codeOf(updateSurvey(shopId, survey.id, unchanged))).toBeNull();

    const fresh = await getEditorSurvey(shopId, survey.id);
    const changed = { ...fresh, targeting: { ...fresh.targeting, minValue: 80 }, questions: fresh.questions.map((q) => ({ ...q })) };
    expect(await codeOf(updateSurvey(shopId, survey.id, changed))).toBe("plan_advanced_targeting");
  });
});
