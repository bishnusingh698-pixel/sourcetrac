/**
 * The quick start (F1) and country presets (F2), against Postgres: the survey it
 * creates goes live, carries the market's answers with every buyer language,
 * shows its follow-up only after the right answers, and its preset answers
 * report under the same channel key as a template's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { upsertShop } from "~/lib/shop.server";
import { clearConfigCache, compileSurvey, createSurvey, getSurveyRow, liveSurveyUsage } from "~/lib/surveys.server";
import { quickStartAnswers, quickStartSurveyInput } from "~/lib/quick-start";
import { readableChannelKey } from "~/lib/channel-key";
import { CHANNEL_MARKETS, marketForCountry } from "@shared/templates/channel-presets";
import { COUNTRY_CODES } from "@shared/countries";
import { LIMITS } from "@shared/survey-rules";
import { visibleQuestionsFor } from "../extensions/shared/src/use-multi-survey";
import type { CompiledQuestion as ExtensionQuestion } from "../extensions/shared/src/survey-logic";

const prisma = new PrismaClient();
const DOMAIN = "quick-start-test.myshopify.com";
let shopId = "";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("_test")) throw new Error(`Refusing to run: DATABASE_URL must name a *_test database (got "${url}").`);
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  shopId = (await upsertShop({ shopDomain: DOMAIN, shopId: "gid://shopify/Shop/9840001" })).id;
  clearConfigCache();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { shopDomain: DOMAIN } });
  await prisma.$disconnect();
});

const japan = marketForCountry("JP");
const allKeys = (country: string) => marketForCountry(country).options.map((o) => o.key);

describe("market presets", () => {
  it("puts every country in a market, and every market within the answer limit", () => {
    expect(marketForCountry("JP").id).toBe("japan");
    expect(marketForCountry("kr").id).toBe("korea");
    expect(marketForCountry("AE").id).toBe("middle_east");
    expect(marketForCountry("BR").id).toBe("brazil");
    expect(marketForCountry("ZZ").id).toBe("global");
    for (const market of CHANNEL_MARKETS) {
      // Nine at most, so "Other" still fits under the limit of ten.
      expect(market.options.length).toBeLessThanOrEqual(LIMITS.MAX_OPTIONS - 1);
      expect(new Set(market.options.map((o) => o.key)).size).toBe(market.options.length);
      for (const code of market.countries) expect(COUNTRY_CODES as readonly string[]).toContain(code);
    }
  });
});

describe("quick start survey", () => {
  it("creates a live survey with the market's answers, translated where generic", async () => {
    const input = quickStartSurveyInput(
      { country: "JP", keys: allKeys("JP"), custom: ["Magazine"], allowOther: true, followUp: false },
      "en",
      "active",
    );
    const survey = await createSurvey(shopId, input);
    expect(survey.status).toBe("active");
    expect(survey.channelReportQuestionId).toBe(survey.questions[0]?.id);
    const labels = survey.questions[0]!.options.map((o) => o.label);
    expect(labels).toContain("LINE");
    expect(labels).toContain("Yahoo! JAPAN");
    expect(labels.at(-1)).toBe("Magazine");
    // "Friend or family" reads in the buyer's language; brand names are not translated.
    const friend = survey.questions[0]!.options.find((o) => o.label === "Friend or family")!;
    expect(friend.translations.ja).toBeTruthy();
    expect(survey.questions[0]!.options.find((o) => o.label === "LINE")!.translations).toEqual({});
    // Frame and question wording in every template language.
    expect((survey.translations.de as { title?: string }).title).toBeTruthy();
    expect(survey.questions[0]!.translations?.ja?.text).toBeTruthy();
    expect(survey.questions[0]!.allowOther).toBe(true);

    const row = await getSurveyRow(shopId, survey.id);
    const line = row!.questions[0]!.options.find((o) => o.label === "LINE")!;
    // Reports read the preset key, so LINE is one channel however it was added.
    expect(
      readableChannelKey({
        shopId,
        optionId: line.id,
        optionTemplateKey: line.templateKey,
        questionTemplateKey: row!.questions[0]!.templateKey,
        label: line.label,
      }),
    ).toBe("line");
  });

  it("asks the creator follow-up only after a social app or creator", async () => {
    const survey = await createSurvey(
      shopId,
      quickStartSurveyInput({ country: "US", keys: allKeys("US"), custom: [], allowOther: false, followUp: true }, "en", "active"),
    );
    const compiled = compileSurvey((await getSurveyRow(shopId, survey.id))!);
    const [channel] = compiled.questions;
    const instagram = channel!.options.find((o) => o.label === "Instagram")!;
    const friend = channel!.options.find((o) => o.label === "Friend or family")!;
    const questions = compiled.questions as unknown as ExtensionQuestion[];
    expect(visibleQuestionsFor(questions, { [channel!.id]: { questionId: channel!.id, optionIds: [instagram.id] } })).toHaveLength(2);
    expect(visibleQuestionsFor(questions, { [channel!.id]: { questionId: channel!.id, optionIds: [friend.id] } })).toHaveLength(1);
  });

  it("drops unknown keys, duplicates and blanks, and never passes the answer limit", () => {
    const { answers } = quickStartAnswers(
      {
        country: "JP",
        keys: [...allKeys("JP"), "not_a_key"],
        custom: ["  ", "line", "One", "Two", "Three"],
        allowOther: false,
        followUp: false,
      },
      "en",
    );
    expect(answers.map((a) => a.label)).not.toContain("not_a_key");
    // "line" repeats LINE (case-insensitive) and is dropped.
    expect(answers.filter((a) => a.label.toLowerCase() === "line")).toHaveLength(1);
    expect(answers).toHaveLength(LIMITS.MAX_OPTIONS);
    expect(japan.options.length).toBe(9);
  });

  it("is created as a draft by the route rule once the plan's live limit is used", async () => {
    await createSurvey(shopId, quickStartSurveyInput({ country: "US", keys: allKeys("US"), custom: [], allowOther: true, followUp: false }, "en", "active"));
    const usage = await liveSurveyUsage(shopId);
    expect(usage.limit).toBe(1);
    expect(usage.live).toBe(1);
    // The route creates a draft here; an active create would be refused.
    await expect(
      createSurvey(shopId, quickStartSurveyInput({ country: "US", keys: allKeys("US"), custom: [], allowOther: true, followUp: false }, "en", "active")),
    ).rejects.toMatchObject({ fields: { code: "plan_live_limit" } });
    const draft = await createSurvey(shopId, quickStartSurveyInput({ country: "US", keys: allKeys("US"), custom: [], allowOther: true, followUp: false }, "en", "draft"));
    expect(draft.status).toBe("draft");
  });
});
