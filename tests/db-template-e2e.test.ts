/**
 * Every template, end to end, against Postgres.
 *
 * For each template on the Free and the Scale plan: create the survey exactly as
 * the library does, compile it into what the checkout block receives, walk it
 * with the block's own follow-up logic (`visibleQuestionsFor`), submit through
 * the real answer path, and resolve its Shopify actions. Unit tests check each
 * template's definition; this checks that the pieces agree once stored, where
 * row ids replace template ids and a mismatch only shows up for a real buyer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, compileSurvey, createSurvey, getSurveyRow, rowToEditor } from "~/lib/surveys.server";
import { submitAnswers } from "~/lib/answers.server";
import { templateSurveyInput, templateUsableOnPlan } from "~/lib/template-survey";
import { TEMPLATES } from "@shared/templates";
import { stableOptionId, stableQuestionId } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import { resolveSmartActionWrites, SMART_ACTION_PRESETS } from "@shared/templates/smart-actions";
import type { CompiledQuestion, CompiledSurvey } from "@shared/survey-config";
import type { AnswerInput } from "@shared/survey-rules";
import { visibleQuestionsFor, type AnswerState } from "../extensions/shared/src/use-multi-survey";
import type { CompiledQuestion as ExtensionQuestion } from "../extensions/shared/src/survey-logic";

const prisma = new PrismaClient();
const DOMAIN = "template-e2e-test.myshopify.com";
const REGION = regionPackFor("US");
let shopId = "";
let orderSeq = 9_100_000_000;
const nextOrder = () => String((orderSeq += 1));

const FIXED: Record<string, string[]> = {
  yes_no: ["yes", "no"],
  satisfaction_5: ["very_dissatisfied", "dissatisfied", "neutral", "satisfied", "very_satisfied"],
};

/** The answer to `q` that opens `wanted` (a follow-up's condition), or a plain one. */
function answerFor(q: CompiledQuestion, wanted?: CompiledQuestion["showIf"]): AnswerInput {
  const trigger = wanted && wanted.questionId === q.id ? wanted : null;
  if (q.type === "yes_no") {
    const id = trigger?.optionIds?.[0] ?? "yes";
    return { questionId: q.id, optionIds: [id], numberValue: id === "yes" ? 1 : 0 };
  }
  if (q.type === "satisfaction_5") {
    return { questionId: q.id, optionIds: [trigger?.optionIds?.[0] ?? "very_satisfied"] };
  }
  if (q.type === "rating_5" || q.type === "nps") {
    return { questionId: q.id, numberValue: trigger?.min ?? (q.type === "nps" ? 9 : 5) };
  }
  if (q.type === "text") return { questionId: q.id, textValue: "Great experience" };
  const plain = q.options.find((o) => !o.isOther && !o.exclusive) ?? q.options[0]!;
  const id = trigger?.optionIds?.find((candidate) => q.options.some((o) => o.id === candidate)) ?? plain.id;
  const chosen = q.options.find((o) => o.id === id)!;
  return { questionId: q.id, optionIds: [id], ...(chosen.isOther ? { otherText: "Somewhere else" } : {}) };
}

/** Answers that make `target` visible, chosen the way a buyer would click. */
function walk(survey: CompiledSurvey, target?: CompiledQuestion): AnswerState {
  const answers: AnswerState = {};
  for (const q of survey.questions) {
    const visible = visibleQuestionsFor(survey.questions as unknown as ExtensionQuestion[], answers).some((v) => v.id === q.id);
    if (!visible) continue;
    // Open the target's condition, or else whichever later follow-up hangs off this question.
    const wanted = target?.showIf ?? survey.questions.find((later) => later.showIf?.questionId === q.id)?.showIf;
    answers[q.id] = answerFor(q, wanted ?? undefined);
  }
  return answers;
}

async function submit(survey: CompiledSurvey, surveyId: string, answers: AnswerInput[], plan: "free" | "scale") {
  const row = (await getSurveyRow(shopId, surveyId))!;
  const editor = rowToEditor(row, { view: "published" });
  return submitAnswers({
    shopId,
    surveyId,
    surveyVersion: survey.version,
    currentVersion: row.version,
    orderId: nextOrder(),
    placement: "thank_you",
    locale: "en",
    answers,
    plan,
    definition: { id: editor.id, name: editor.name, title: editor.title, layout: editor.layout, questions: editor.questions },
  } as Parameters<typeof submitAnswers>[0]);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9830001", accessToken: null })).id;
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

for (const plan of ["free", "scale"] as const) {
  describe(`every template on ${plan}`, () => {
    // The library only offers After delivery when the survey-link page is on.
    for (const template of TEMPLATES) {
      it(`${template.id}: creates, compiles, opens every follow-up and stores an answer`, async () => {
        await prisma.shop.update({ where: { id: shopId }, data: { plan, planStatus: "active" } });
        // A store has a survey cap; each case starts from an empty store.
        await prisma.survey.deleteMany({ where: { shopId } });
        if (!templateUsableOnPlan(template, plan)) {
          expect(templateSurveyInput({ template, locale: "en", region: REGION, plan }).ok).toBe(false);
          return;
        }
        const built = templateSurveyInput({ template, locale: "en", region: REGION, plan });
        if (!built.ok) throw new Error("expected a usable template");
        const created = await createSurvey(shopId, built.input);
        const survey = compileSurvey((await getSurveyRow(shopId, created.id))!);
        expect(survey.questions.length).toBeGreaterThan(0);

        // Every follow-up names an earlier question and options it really has.
        survey.questions.forEach((q, index) => {
          if (!q.showIf) return;
          const parent = survey.questions.slice(0, index).find((p) => p.id === q.showIf!.questionId);
          expect(parent, `${q.id} depends on a missing question`).toBeTruthy();
          const known = FIXED[parent!.type] ?? parent!.options.map((o) => o.id);
          for (const id of q.showIf.optionIds ?? []) expect(known).toContain(id);
          // And a buyer can actually reach it.
          const answers = walk(survey, q);
          expect(visibleQuestionsFor(survey.questions as unknown as ExtensionQuestion[], answers).map((v) => v.id)).toContain(q.id);
        });

        // "Other (please specify)" opens a text box and is listed last.
        for (const q of survey.questions) {
          const others = q.options.filter((o) => o.isOther);
          expect(others.length).toBeLessThanOrEqual(1);
          const labelledOther = q.options.filter((o) => /please specify/i.test(o.label));
          expect(labelledOther.every((o) => o.isOther), `${q.id} has an "Other" option without a text box`).toBe(true);
        }

        // A buyer who answers everything they are shown is stored.
        const answers = walk(survey);
        const visible = visibleQuestionsFor(survey.questions as unknown as ExtensionQuestion[], answers);
        const result = await submit(
          survey,
          created.id,
          visible.map((q) => answers[q.id]!),
          plan,
        );
        expect(result.outcome, JSON.stringify(result)).toBe("created");

        // Picking "Other" without saying what is refused; with text it is stored.
        const withOther = survey.questions.find((q) => q.type === "single_choice" && !q.showIf && q.options.some((o) => o.isOther));
        if (withOther) {
          const other = withOther.options.find((o) => o.isOther)!;
          const base = visible.map((q) => answers[q.id]!).filter((a) => a.questionId !== withOther.id);
          const blank = await submit(survey, created.id, [...base, { questionId: withOther.id, optionIds: [other.id] }], plan);
          expect(blank.outcome).toBe("invalid");
          const typed = await submit(survey, created.id, [...base, { questionId: withOther.id, optionIds: [other.id], otherText: "A podcast" }], plan);
          expect(typed.outcome).toBe("created");
        }
      });
    }
  });
}

describe("smart actions", () => {
  for (const template of TEMPLATES.filter((t) => (t.smartActions ?? []).length > 0)) {
    it(`${template.id}: every preset writes for a matching answer`, () => {
      for (const presetId of template.smartActions!) {
        const preset = SMART_ACTION_PRESETS[presetId]!;
        const question = template.questions.find((q) => q.key === preset.questionKey)!;
        const optionKey = preset.onlyForOptionKeys?.[0] ?? Object.keys(preset.valueMap ?? {})[0] ?? question.options?.[0]?.key ?? "instagram";
        const answers = [
          preset.numericBands
            ? { questionId: stableQuestionId(template.id, question.key), optionIds: [], numberValue: preset.numericBands[0]!.min ?? preset.numericBands[0]!.max ?? 0 }
            : question.type === "yes_no"
              ? { questionId: stableQuestionId(template.id, question.key), optionIds: ["yes"], numberValue: 1 }
              : { questionId: stableQuestionId(template.id, question.key), optionIds: [stableOptionId(template.id, question.key, optionKey)], numberValue: null },
        ];
        if (preset.gateQuestionKey) {
          answers.push({ questionId: stableQuestionId(template.id, preset.gateQuestionKey), optionIds: ["yes"], numberValue: 1 });
        }
        const writes = resolveSmartActionWrites({ templateId: template.id, presetIds: [presetId], answers, isFirstOrder: true });
        const total = writes.orderTags.length + writes.customerTags.length + writes.customerMetafields.length;
        expect(total, `${presetId} wrote nothing`).toBeGreaterThan(0);
        for (const tag of [...writes.orderTags, ...writes.customerTags]) expect(tag).not.toMatch(/[{}]/);
      }
    });
  }
});

describe("the Other-option migration", () => {
  it("gives existing template surveys their text box back, and touches nothing else", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
    await prisma.survey.deleteMany({ where: { shopId } });
    const template = TEMPLATES.find((t) => t.id === "channel-compass")!;
    const built = templateSurveyInput({ template, locale: "en", region: REGION, plan: "scale" });
    if (!built.ok) throw new Error("expected a usable template");
    const created = await createSurvey(shopId, built.input);
    // As surveys made before the fix were stored.
    await prisma.option.updateMany({ where: { question: { surveyId: created.id } }, data: { isOther: false } });

    const sql = readFileSync("prisma/migrations/20261018170000_template_other_options/migration.sql", "utf8");
    await prisma.$executeRawUnsafe(sql);

    const options = await prisma.option.findMany({ where: { question: { surveyId: created.id } } });
    const flagged = options.filter((o) => o.isOther).map((o) => o.templateKey);
    expect(flagged).toEqual([stableOptionId("channel-compass", "q_channel", "other")]);
  });
});

describe("which question feeds the Channel report", () => {
  async function fromTemplate(id: string) {
    await prisma.shop.update({ where: { id: shopId }, data: { plan: "scale", planStatus: "active" } });
    const template = TEMPLATES.find((t) => t.id === id)!;
    const built = templateSurveyInput({ template, locale: "en", region: REGION, plan: "scale" });
    if (!built.ok) throw new Error("expected a usable template");
    return createSurvey(shopId, { ...built.input, status: "active" });
  }

  it("is the channel question for Channel Compass, and none for a gift survey", async () => {
    await prisma.survey.deleteMany({ where: { shopId } });
    const compass = await fromTemplate("channel-compass");
    const gift = await fromTemplate("gift-radar");
    expect(compass.channelReportQuestionId).toBe(compass.questions[0]!.id);
    expect(gift.channelReportQuestionId).toBeNull();

    // A gift answer must not appear as a marketing channel.
    const giftSurvey = compileSurvey((await getSurveyRow(shopId, gift.id))!);
    const recipient = giftSurvey.questions[0]!;
    const answer = await submit(giftSurvey, gift.id, [answerFor(recipient)], "scale");
    expect(answer.outcome).toBe("created");
    const { channelCountsForShop } = await import("~/lib/analytics-queries.server");
    expect(await channelCountsForShop(shopId)).toEqual([]);
  });

  it("follows the editor's checkbox, on and off", async () => {
    await prisma.survey.deleteMany({ where: { shopId } });
    const gift = await fromTemplate("gift-radar");
    const { updateSurvey } = await import("~/lib/surveys.server");
    const row = (await getSurveyRow(shopId, gift.id))!;
    const editor = rowToEditor(row);
    // A live survey's save is held as a draft, then published, as in the editor.
    const { publishSurveyDraft } = await import("~/lib/surveys.server");
    let saved = await updateSurvey(shopId, gift.id, { ...editor, channelReportQuestionId: editor.questions[0]!.id }, editor.revision);
    saved = await publishSurveyDraft(shopId, gift.id, saved.revision);
    expect(saved.channelReportQuestionId).toBe(editor.questions[0]!.id);
    saved = await updateSurvey(shopId, gift.id, { ...saved, channelReportQuestionId: null }, saved.revision);
    saved = await publishSurveyDraft(shopId, gift.id, saved.revision);
    expect(saved.channelReportQuestionId).toBeNull();
  });

  it("the migration unpicks a template's non-channel question and keeps the channel one", async () => {
    await prisma.survey.deleteMany({ where: { shopId } });
    const compass = await fromTemplate("channel-compass");
    const gift = await fromTemplate("gift-radar");
    // As surveys made before the fix were stored: the first choice question.
    await prisma.survey.update({ where: { id: gift.id }, data: { channelReportQuestionId: gift.questions[0]!.id } });

    const sql = readFileSync("prisma/migrations/20261018171000_channel_question_only_for_channels/migration.sql", "utf8");
    await prisma.$executeRawUnsafe(sql);

    expect((await prisma.survey.findUnique({ where: { id: gift.id } }))!.channelReportQuestionId).toBeNull();
    expect((await prisma.survey.findUnique({ where: { id: compass.id } }))!.channelReportQuestionId).toBe(compass.questions[0]!.id);
  });
});
