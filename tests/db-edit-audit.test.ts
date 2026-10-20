/**
 * Survey editing fixes from the 2026-10-20 audit, against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import {
  clearConfigCache,
  createSurvey,
  deleteSurvey,
  getCompiledConfig,
  getEditorSurvey,
  publishSurveyDraft,
  setSurveyStatus,
  updateSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";

const prisma = new PrismaClient();
const DOMAIN = "edit-audit-test.myshopify.com";
let shopId = "";

function input(over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name: "Edit audit",
    status: "draft",
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      { type: "single_choice", text: "Where?", required: true, options: [{ label: "Instagram" }, { label: "Google" }, { label: "Friend" }] },
    ],
    ...over,
  };
}

async function asPosted(surveyId: string) {
  const editor = await getEditorSurvey(shopId, surveyId);
  return { ...editor, questions: editor.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })) };
}

beforeAll(() => {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("Refusing to run: DATABASE_URL must name a *_test database.");
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9810001" })).id;
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("editing (2026-10-20 audit)", () => {
  it("archives an option removed from a live survey with no answers yet (M11)", async () => {
    const survey = await createSurvey(shopId, input({ status: "active" }));
    const posted = await asPosted(survey.id);
    const removed = posted.questions[0]!.options.pop()!;
    const saved = await updateSurvey(shopId, survey.id, posted, posted.revision);
    await publishSurveyDraft(shopId, survey.id, saved.revision);
    const row = await prisma.option.findUnique({ where: { id: removed.id } });
    expect(row?.archived).toBe(true);
  });

  it("refuses an order-value minimum above the maximum (L49)", async () => {
    await expect(
      createSurvey(shopId, input({ targeting: { minValue: 100, maxValue: 50, valueCurrency: "USD" } })),
    ).rejects.toMatchObject({ fields: { code: "order_value_range" } });
  });

  it("refuses a layout no block knows and a title that is not text (L49)", async () => {
    await expect(createSurvey(shopId, input({ layout: "grid" as never }))).rejects.toMatchObject({ fields: { code: "invalid_layout" } });
    await expect(createSurvey(shopId, input({ title: 42 as never }))).rejects.toMatchObject({ fields: { code: "invalid_text" } });
  });

  it("keeps a cleared intro cleared in a live survey's draft (L49)", async () => {
    const survey = await createSurvey(shopId, input({ status: "active", intro: "Hello" }));
    const posted = await asPosted(survey.id);
    const saved = await updateSurvey(shopId, survey.id, { ...posted, intro: null }, posted.revision);
    expect(saved.intro).toBeNull();
  });

  it("lets a downgraded shop narrow a kept setting, whatever its key order (L49)", async () => {
    const survey = await createSurvey(shopId, input({ targeting: { countries: ["DE", "FR"] }, syncOptions: { orderTags: ["a"], flowTrigger: true } }));
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "free" } });
    const posted = await asPosted(survey.id);
    const saved = await updateSurvey(
      shopId,
      survey.id,
      { ...posted, targeting: { countries: ["DE"] }, syncOptions: { flowTrigger: true, orderTags: ["a"] } },
      posted.revision,
    );
    expect(saved.targeting.countries).toEqual(["DE"]);
    // Widening is still a paid feature.
    const again = await asPosted(survey.id);
    await expect(
      updateSurvey(shopId, survey.id, { ...again, targeting: { countries: ["DE", "IT"] } }, again.revision),
    ).rejects.toMatchObject({ fields: { code: "plan_advanced_targeting" } });
  });

  it("only takes a one-answer choice question as the channel question (I23)", async () => {
    const survey = await createSurvey(
      shopId,
      input({ questions: [{ type: "yes_no", text: "First time?" }], channelReportQuestionId: undefined }),
    );
    const posted = await asPosted(survey.id);
    const saved = await updateSurvey(shopId, survey.id, { ...posted, channelReportQuestionId: posted.questions[0]!.id }, posted.revision);
    expect(saved.channelReportQuestionId).toBeNull();
  });

  it("stops rotating surveys after a downgrade (I23)", async () => {
    await createSurvey(shopId, input({ status: "active", rotation: true }));
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "growth" } });
    clearConfigCache();
    const config = await getCompiledConfig(shopId);
    expect(config.surveys.every((s) => s.rotation === false)).toBe(true);
  });

  it("answers two deletes racing as not found, never a database error (L49)", async () => {
    const survey = await createSurvey(shopId, input());
    const results = await Promise.allSettled([deleteSurvey(shopId, survey.id), deleteSurvey(shopId, survey.id)]);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as Error).name).toBe("NotFoundError");
    }
    expect(await prisma.survey.count({ where: { id: survey.id } })).toBe(0);
    await expect(setSurveyStatus(shopId, survey.id, "active")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("refuses a survey too large for the checkout on the server (L49)", async () => {
    const huge = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`x${i}`, "y".repeat(190)]));
    await expect(createSurvey(shopId, input({ translations: huge as never }))).rejects.toMatchObject({ fields: { code: "config_too_large" } });
  });

  it("does not cache a config read that an invalidation overtook (M13)", async () => {
    const survey = await createSurvey(shopId, input({ status: "active" }));
    const read = getCompiledConfig(shopId);
    await setSurveyStatus(shopId, survey.id, "paused");
    await read;
    const after = await getCompiledConfig(shopId);
    expect(after.surveys.map((s) => s.id)).not.toContain(survey.id);
  });
});
