/**
 * Survey editor persistence, against real Postgres: id remapping for template,
 * new and duplicated items, archived rows, atomic revisions, and server-side
 * guards on everything the Studio posts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import {
  createSurvey,
  discardSurveyDraft,
  duplicateSurvey,
  getEditorSurvey,
  listSurveys,
  publishSurveyDraft,
  reorderSurveys,
  setSurveyStatus,
  updateSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";
import { templateById } from "@shared/templates";
import { buildSurveyDefinition } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import { LIMITS } from "@shared/survey-rules";

const prisma = new PrismaClient();
const DOMAIN = "survey-editor-test.myshopify.com";
let shopId = "";

function input(over: Partial<SurveyInput> = {}): SurveyInput {
  return {
    name: "Editor",
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

/** The editor's view, posted back as the Studio does. */
async function asPosted(surveyId: string): Promise<SurveyInput & { revision: number }> {
  const editor = await getEditorSurvey(shopId, surveyId);
  return { ...editor, questions: editor.questions.map((q) => ({ ...q })) };
}

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  const shop = await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9800001", accessToken: null });
  shopId = shop.id;
  await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

describe("template surveys keep their logic (C5)", () => {
  it("remaps show-if to saved ids, stores template keys, and can be created twice", async () => {
    const template = templateById("switch-story")!;
    const definition = buildSurveyDefinition({ template, locale: "en", region: regionPackFor("US") });
    const make = () =>
      createSurvey(shopId, input({ templateId: template.id, templateVersion: template.version, questions: definition.questions }));

    const first = await make();
    const second = await make();
    expect(second.id).not.toBe(first.id);

    const rows = await prisma.question.findMany({ where: { surveyId: first.id }, include: { options: true } });
    const ids = new Set(rows.map((q) => q.id));
    const optionIds = new Set(rows.flatMap((q) => q.options.map((o) => o.id)));
    const dependent = rows.filter((q) => q.showIf);
    expect(dependent.length).toBeGreaterThan(0);
    for (const q of dependent) {
      const cond = JSON.parse(q.showIf!) as { questionId: string; optionIds?: string[] };
      expect(ids.has(cond.questionId)).toBe(true);
      for (const id of cond.optionIds ?? []) expect(optionIds.has(id)).toBe(true);
    }
    expect(rows.every((q) => q.templateKey?.startsWith("switch_story_"))).toBe(true);

    // The next Studio save of the same survey still validates.
    await expect(updateSurvey(shopId, first.id, await asPosted(first.id))).resolves.toBeTruthy();
  });
});

describe("new items in one edit (H10, M21)", () => {
  it("saves two new options and a show-if on an option added in the same edit", async () => {
    const survey = await createSurvey(shopId, input());
    const posted = await asPosted(survey.id);
    posted.questions[0]!.options!.push({ id: "new_a", label: "TikTok" }, { id: "new_b", label: "Podcast" });
    posted.questions.push({
      id: "new_q",
      type: "text",
      text: "Which creator?",
      required: false,
      showIf: { questionId: posted.questions[0]!.id!, optionIds: ["new_a"] },
    });
    const saved = await updateSurvey(shopId, survey.id, posted);
    const tiktok = saved.questions[0]!.options.find((o) => o.label === "TikTok")!;
    expect(saved.questions[1]!.showIf).toEqual({ questionId: saved.questions[0]!.id, optionIds: [tiktok.id] });

    // Legacy empty ids are no longer duplicates either.
    const again = await asPosted(survey.id);
    again.questions[0]!.options!.push({ id: "", label: "Radio" }, { id: "", label: "TV" });
    await expect(updateSurvey(shopId, survey.id, again)).resolves.toBeTruthy();
  });
});

describe("removed items stay removed (H11)", () => {
  it("does not resurrect an archived option on the next save", async () => {
    const survey = await createSurvey(shopId, input({ questions: [{ type: "single_choice", text: "Where?", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] }));
    await prisma.survey.update({ where: { id: survey.id }, data: { responseCount: 3 } });
    const posted = await asPosted(survey.id);
    posted.questions[0]!.options = posted.questions[0]!.options!.filter((o) => o.label !== "C");
    await updateSurvey(shopId, survey.id, posted);
    await updateSurvey(shopId, survey.id, await asPosted(survey.id));
    const c = await prisma.option.findFirstOrThrow({ where: { label: "C", question: { surveyId: survey.id } } });
    expect(c.archived).toBe(true);
    expect((await getEditorSurvey(shopId, survey.id)).questions[0]!.options.map((o) => o.label)).toEqual(["A", "B"]);
  });
});

describe("revisions are claimed atomically (H12, M22)", () => {
  it("lets only one of two saves at the same revision through", async () => {
    const survey = await createSurvey(shopId, input());
    const posted = await asPosted(survey.id);
    const results = await Promise.allSettled([
      updateSurvey(shopId, survey.id, { ...posted, name: "One" }, posted.revision),
      updateSurvey(shopId, survey.id, { ...posted, name: "Two" }, posted.revision),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses a discard from a stale revision", async () => {
    const survey = await createSurvey(shopId, input({ status: "active" }));
    const posted = await asPosted(survey.id);
    await updateSurvey(shopId, survey.id, { ...posted, name: "Draft" }, posted.revision);
    await expect(discardSurveyDraft(shopId, survey.id, posted.revision)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("duplicate (H14)", () => {
  it("copies show-if, template provenance and design", async () => {
    const template = templateById("switch-story")!;
    const definition = buildSurveyDefinition({ template, locale: "en", region: regionPackFor("US") });
    const source = await createSurvey(
      shopId,
      input({ templateId: template.id, templateVersion: template.version, questions: definition.questions, design: { layout: "one_by_one" } }),
    );
    const copy = await duplicateSurvey(shopId, source.id);
    expect(copy.templateId).toBe(template.id);
    expect(copy.design.layout).toBe("one_by_one");
    const dependent = copy.questions.find((q) => q.showIf)!;
    expect(copy.questions.some((q) => q.id === dependent.showIf!.questionId)).toBe(true);
  });
});

describe("server-side guards", () => {
  it("rejects bad placements, sample and rotation weight (M25)", async () => {
    await expect(createSurvey(shopId, input({ placements: ["bogus" as never] }))).rejects.toMatchObject({ fields: { code: "invalid_placement" } });
    await expect(createSurvey(shopId, input({ targeting: { samplePercent: 0 } }))).rejects.toMatchObject({ fields: { code: "invalid_sample" } });
    await expect(createSurvey(shopId, input({ rotationWeight: 1.5 }))).rejects.toMatchObject({ fields: { code: "invalid_rotation_weight" } });
  });

  it("does not take status or priority from a save, nor double-encode the design (M26, L51, L52)", async () => {
    const survey = await createSurvey(shopId, input());
    await reorderSurveys(shopId, [survey.id]);
    const posted = await asPosted(survey.id);
    const { design: _design, ...withoutDesign } = posted;
    await updateSurvey(shopId, survey.id, { ...withoutDesign, status: "active", priority: 0 });
    const row = await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } });
    expect(row.status).toBe("draft");
    expect(row.priority).toBe(1);
    expect(typeof JSON.parse(row.designJson)).toBe("object");
  });

  it("refuses to publish a live survey with no placements, and a corrupt draft (M26, L53)", async () => {
    const survey = await createSurvey(shopId, input({ status: "active" }));
    const posted = await asPosted(survey.id);
    const saved = await updateSurvey(shopId, survey.id, { ...posted, placements: [] }, posted.revision);
    await expect(publishSurveyDraft(shopId, survey.id, saved.revision)).rejects.toMatchObject({ fields: { code: "no_placements" } });
    await prisma.survey.update({ where: { id: survey.id }, data: { draft: "null" } });
    await expect(publishSurveyDraft(shopId, survey.id)).rejects.toMatchObject({ fields: { code: "no_draft" } });
  });

  it("refuses a type change on an answered question (M28)", async () => {
    const survey = await createSurvey(shopId, input());
    await prisma.survey.update({ where: { id: survey.id }, data: { responseCount: 1 } });
    const posted = await asPosted(survey.id);
    posted.questions[0] = { ...posted.questions[0]!, type: "nps", options: [] };
    await expect(updateSurvey(shopId, survey.id, posted)).rejects.toMatchObject({ fields: { code: "type_locked" } });
  });

  it("enforces the live-survey limit and refuses pausing a draft (M24, L62)", async () => {
    for (let i = 0; i < LIMITS.MAX_ACTIVE_SURVEYS; i += 1) await createSurvey(shopId, input({ status: "active", name: `S${i}` }));
    const extra = await createSurvey(shopId, input({ name: "Extra" }));
    await expect(setSurveyStatus(shopId, extra.id, "active")).rejects.toMatchObject({ fields: { code: "too_many_active" } });
    await expect(setSurveyStatus(shopId, extra.id, "paused")).rejects.toMatchObject({ fields: { code: "not_live" } });
  });

  it("orders equal priorities by creation, not by last answer (M23)", async () => {
    const a = await createSurvey(shopId, input({ name: "A" }));
    const b = await createSurvey(shopId, input({ name: "B" }));
    await prisma.survey.update({ where: { id: b.id }, data: { responseCount: { increment: 1 } } });
    expect((await listSurveys(shopId)).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("never moves an option to another question (L54)", async () => {
    const survey = await createSurvey(
      shopId,
      input({ questions: [
        { type: "single_choice", text: "One", options: [{ label: "A" }, { label: "B" }] },
        { type: "single_choice", text: "Two", options: [{ label: "C" }, { label: "D" }] },
      ] }),
    );
    const posted = await asPosted(survey.id);
    const stolen = posted.questions[0]!.options![0]!;
    posted.questions[1]!.options!.push({ ...stolen });
    const saved = await updateSurvey(shopId, survey.id, posted);
    const original = await prisma.option.findUniqueOrThrow({ where: { id: stolen.id! } });
    expect(original.questionId).toBe(saved.questions[0]!.id);
    expect(saved.questions[1]!.options.map((o) => o.label)).toEqual(["C", "D", "A"]);
  });
});
