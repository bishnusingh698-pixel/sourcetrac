import { describe, expect, it } from "vitest";

import {
  FEATURE_PLAN,
  liveSurveyLimit,
  planHas,
  usesAdvancedTargeting,
  usesShopifyActions,
} from "@shared/plan-features";
import { TEMPLATES, templateById } from "@shared/templates";
import { templateRequiredPlan } from "@shared/templates/catalog";
import { TEMPLATE_LOCALES } from "@shared/templates/locales";
import { describeFollowUp } from "@shared/survey-summary";
import { LIMITS } from "@shared/survey-rules";
import { templateSurveyInput, templateUsableOnPlan } from "~/lib/template-survey";
import { PLANS } from "~/lib/plans";
import { localizeSurvey, matchLocale } from "../../extensions/shared/src/use-multi-survey";

/**
 * The simplified setup: plan gates, one-step template creation, and the
 * buyer-language overlay that replaced the preview's language switch.
 */

describe("plan features", () => {
  it("puts reach on Growth and automation on Scale", () => {
    expect(FEATURE_PLAN).toEqual({
      full_templates: "growth",
      advanced_targeting: "growth",
      shopify_actions: "scale",
      auto_stop: "scale",
      rotation: "scale",
    });
    expect(planHas("free", "advanced_targeting")).toBe(false);
    expect(planHas("growth", "advanced_targeting")).toBe(true);
    expect(planHas("growth", "shopify_actions")).toBe(false);
    expect(planHas("scale", "shopify_actions")).toBe(true);
  });

  it("allows 1, 3 and 10 live surveys", () => {
    expect([liveSurveyLimit("free"), liveSurveyLimit("growth"), liveSurveyLimit("scale")]).toEqual([1, 3, 10]);
    expect(liveSurveyLimit("scale")).toBeLessThanOrEqual(LIMITS.MAX_ACTIVE_SURVEYS);
  });

  it("lists the live-survey limit on every plan card", () => {
    for (const plan of Object.values(PLANS)) {
      const feature = plan.features.find((f) => f.key === "plans.feature_live_surveys");
      expect(feature?.params?.count, plan.key).toBe(liveSurveyLimit(plan.key));
    }
  });

  it("keeps new vs returning buyers free, and 100% sampling is no rule at all", () => {
    expect(usesAdvancedTargeting({})).toBe(false);
    expect(usesAdvancedTargeting(null)).toBe(false);
    expect(usesAdvancedTargeting({ samplePercent: 100 })).toBe(false);
    expect(usesAdvancedTargeting({ countries: [] })).toBe(false);
    expect(usesAdvancedTargeting({ samplePercent: 50 })).toBe(true);
    expect(usesAdvancedTargeting({ minValue: 20 })).toBe(true);
    expect(usesAdvancedTargeting({ countries: ["US"] })).toBe(true);
    // customerType is not one of the advanced fields.
    expect(usesAdvancedTargeting({ customerType: "first_order" } as never)).toBe(false);
  });

  it("treats any tag, metafield, preset or Flow trigger as a Shopify action", () => {
    expect(usesShopifyActions({})).toBe(false);
    expect(usesShopifyActions(null)).toBe(false);
    expect(usesShopifyActions({ orderTags: [] })).toBe(false);
    expect(usesShopifyActions({ orderTags: ["x"] })).toBe(true);
    expect(usesShopifyActions({ presets: ["channel_order_tag"] })).toBe(true);
    expect(usesShopifyActions({ flowTrigger: true })).toBe(true);
    expect(usesShopifyActions({ flowTrigger: false })).toBe(false);
  });
});

describe("templates on each plan", () => {
  it("gives Free the whole 'How did you hear about us?' survey", () => {
    const template = templateById("channel-compass")!;
    expect(templateRequiredPlan(template)).toBe("free");
    const built = templateSurveyInput({ template, locale: "en", region: "us", plan: "free" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.lite).toBe(false);
    expect(built.input.questions).toHaveLength(3);
  });

  it("gives Free the short version of a template with extra questions", () => {
    const template = templateById("purchase-reason")!;
    expect(templateRequiredPlan(template)).toBe("growth");
    expect(templateUsableOnPlan(template, "free")).toBe(true);

    const free = templateSurveyInput({ template, locale: "en", region: "us", plan: "free" });
    const growth = templateSurveyInput({ template, locale: "en", region: "us", plan: "growth" });
    expect(free.ok && free.lite && free.input.questions.length).toBe(1);
    expect(growth.ok && !growth.lite && growth.input.questions.length).toBe(2);
  });

  it("never turns on auto-stop below Scale", () => {
    const template = TEMPLATES.find((t) => t.defaults.learnAndStop) ?? null;
    if (!template) return;
    const free = templateSurveyInput({ template, locale: "en", region: "us", plan: "free" });
    const scale = templateSurveyInput({ template, locale: "en", region: "us", plan: "scale" });
    if (free.ok) expect(free.input.learnAndStop).toBe(false);
    if (scale.ok) expect(scale.input.learnAndStop).toBe(true);
  });

  it("creates every template with no Shopify actions turned on", () => {
    for (const template of TEMPLATES) {
      const built = templateSurveyInput({ template, locale: "en", region: "us", plan: "scale" });
      if (built.ok) expect(usesShopifyActions(built.input.syncOptions), template.id).toBe(false);
    }
  });
});

describe("template translations", () => {
  it("stores every other language, so buyers read their own", () => {
    const template = templateById("almost-left")!;
    const built = templateSurveyInput({ template, locale: "en", region: "us", plan: "scale" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const others = TEMPLATE_LOCALES.filter((code) => code !== "en");
    expect(Object.keys(built.input.translations ?? {}).sort()).toEqual([...others].sort());
    const [first] = built.input.questions;
    expect(Object.keys(first!.translations ?? {}).sort()).toEqual([...others].sort());
    expect(first!.translations!.de!.text).not.toBe(first!.text);
  });

  it("leaves out option labels that read the same in a language", () => {
    const built = templateSurveyInput({ template: templateById("channel-compass")!, locale: "en", region: "us", plan: "scale" });
    if (!built.ok) throw new Error("not built");
    const instagram = built.input.questions[0]!.options!.find((o) => o.label === "Instagram")!;
    expect(instagram.translations).toEqual({});
    const google = built.input.questions[0]!.options!.find((o) => o.label === "Google search")!;
    expect(google.translations!.de).toBe("Google-Suche");
  });

  it("fits every translation inside the editor's limits, in every admin language", () => {
    for (const template of TEMPLATES) {
      for (const locale of TEMPLATE_LOCALES) {
        const built = templateSurveyInput({ template, locale, region: "global", plan: "scale" });
        if (!built.ok) continue;
        const size = new TextEncoder().encode(JSON.stringify(built.input)).length;
        expect(size, `${template.id}/${locale} size`).toBeLessThanOrEqual(LIMITS.MAX_COMPILED_CONFIG_BYTES);
        for (const question of built.input.questions) {
          for (const text of Object.values(question.translations ?? {})) {
            expect(text!.text.length, `${template.id}/${locale}`).toBeLessThanOrEqual(LIMITS.MAX_QUESTION_TEXT);
          }
          for (const option of question.options ?? []) {
            for (const label of Object.values(option.translations ?? {})) {
              expect((label as string).length, `${template.id}/${locale}`).toBeLessThanOrEqual(LIMITS.MAX_OPTION_LABEL);
            }
          }
        }
      }
    }
  });
});

describe("buyer language", () => {
  const available = ["de", "fr", "pt-BR", "zh-CN"];

  it("matches exact, bare and regional codes", () => {
    expect(matchLocale("de", available)).toBe("de");
    expect(matchLocale("de-AT", available)).toBe("de");
    expect(matchLocale("pt-BR", available)).toBe("pt-BR");
    expect(matchLocale("pt-PT", available)).toBe("pt-BR");
    expect(matchLocale("zh-cn", available)).toBe("zh-CN");
    expect(matchLocale("ko", available)).toBeNull();
    expect(matchLocale(null, available)).toBeNull();
  });

  it("overlays question, option and frame text, and falls back to the default", () => {
    const survey = {
      id: "s1",
      title: "Quick question",
      intro: null,
      buttonLabel: "Submit",
      thankYouText: "Thanks!",
      translations: { de: { title: "Kurze Frage", buttonLabel: "Senden", thankYouText: "Danke!" } },
      questions: [
        {
          id: "q1",
          type: "single_choice",
          text: "Where did you first hear about us?",
          helpText: null,
          placeholder: null,
          options: [
            { id: "o1", label: "Instagram", translations: {} },
            { id: "o2", label: "Google search", translations: { de: "Google-Suche" } },
          ],
          translations: { de: { text: "Wo haben Sie zuerst von uns gehört?" } },
        },
      ],
    } as unknown as Parameters<typeof localizeSurvey>[0];

    const de = localizeSurvey(survey, "de-DE");
    expect(de.title).toBe("Kurze Frage");
    expect(de.buttonLabel).toBe("Senden");
    expect(de.questions[0]!.text).toBe("Wo haben Sie zuerst von uns gehört?");
    expect(de.questions[0]!.options.map((o) => o.label)).toEqual(["Instagram", "Google-Suche"]);

    expect(localizeSurvey(survey, "ja")).toBe(survey);
    expect(localizeSurvey(survey, null)).toBe(survey);
  });
});

describe("describeFollowUp", () => {
  const questions = [
    { id: "a", type: "single_choice" as const, options: [{ id: "x", label: "Instagram" }] },
    { id: "b", type: "yes_no" as const, options: [] },
    { id: "c", type: "nps" as const, options: [] },
  ];

  it("returns null for a question that is always asked", () => {
    expect(describeFollowUp({ showIf: null }, questions as never)).toBeNull();
  });

  it("names the parent and the merchant's option label", () => {
    expect(describeFollowUp({ showIf: { questionId: "a", optionIds: ["x"] } }, questions as never)).toEqual({
      parentNumber: 1,
      options: [{ id: "x", label: "Instagram" }],
      min: null,
      max: null,
    });
  });

  it("leaves fixed Yes / No labels to the admin", () => {
    expect(describeFollowUp({ showIf: { questionId: "b", optionIds: ["yes"] } }, questions as never)?.options).toEqual([
      { id: "yes", label: null },
    ]);
  });

  it("reports a score range, and a missing parent as 0", () => {
    const range = describeFollowUp({ showIf: { questionId: "c", min: 0, max: 6 } }, questions as never);
    expect(range).toMatchObject({ parentNumber: 3, min: 0, max: 6 });
    expect(describeFollowUp({ showIf: { questionId: "gone", optionIds: ["x"] } }, questions as never)?.parentNumber).toBe(0);
  });
});
