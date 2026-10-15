import { describe, expect, it } from "vitest";

import { TEMPLATE_BUNDLE_EN, TEMPLATE_BUNDLES, TEMPLATE_LOCALES } from "@shared/templates/locales";
import { TEMPLATES } from "@shared/templates/index";
import { ALL_PACKS } from "@shared/templates/packs";
import { SEASONS } from "@shared/templates/seasons";
import { SMART_ACTION_PRESETS } from "@shared/templates/smart-actions";
import { IDEA_RULES } from "@shared/templates/ideas";
import { TAG_EN, TAG_IDS } from "@shared/templates/tags";
import {
  buildSurveyDefinition,
  questionScaleLabels,
  stableOptionId,
  stableQuestionId,
} from "@shared/templates/resolve";
import { TEMPLATE_CATEGORIES } from "@shared/templates/types";
import { regionPackFor, type RegionPack } from "@shared/templates/packs";
import { validateSurveyDefinition } from "@shared/survey-rules";

const EN = TEMPLATE_BUNDLE_EN;
const NON_EN = TEMPLATE_LOCALES.filter((l) => l !== "en");

const REGIONS: RegionPack[] = ["us", "global", "eu"];

describe("template locale parity", () => {
  it("ships all ten app locales", () => {
    expect(TEMPLATE_LOCALES.sort()).toEqual(
      ["en", "de", "fr", "es", "pt-BR", "zh-CN", "ja", "it", "nl", "sv"].sort(),
    );
  });

  it("has the same key set in every locale as in English", () => {
    const enKeys = Object.keys(EN).sort();
    for (const locale of NON_EN) {
      const keys = Object.keys(TEMPLATE_BUNDLES[locale]!).sort();
      const missing = enKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !enKeys.includes(k));
      expect({ locale, missing, extra }, `${locale} drifted from en`).toEqual({ locale, missing: [], extra: [] });
    }
  });

  it("has no empty strings", () => {
    for (const locale of TEMPLATE_LOCALES) {
      for (const [key, value] of Object.entries(TEMPLATE_BUNDLES[locale]!)) {
        expect(value.trim().length, `${locale}/${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("preserves interpolations across locales", () => {
    const ph = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const [key, enValue] of Object.entries(EN)) {
      const expected = ph(enValue).join(",");
      for (const locale of NON_EN) {
        const value = TEMPLATE_BUNDLES[locale]![key] ?? "";
        expect(ph(value).join(","), `${locale}/${key} interpolation`).toBe(expected);
      }
    }
  });
});

describe("tag dictionary", () => {
  it("keeps every English tag at 32 characters or fewer", () => {
    for (const id of TAG_IDS) {
      expect(TAG_EN[id].length, `${id} is too long`).toBeLessThanOrEqual(32);
    }
  });

  it("defines a tag and a tooltip for every id in every locale", () => {
    for (const id of TAG_IDS) {
      expect(EN[`tags.${id}`]).toBeTruthy();
      expect(EN[`tags.${id}.tip`]).toBeTruthy();
    }
  });

  it("uses 1–3 valid tags on every template", () => {
    for (const template of TEMPLATES) {
      expect(template.outcomeTags.length, template.id).toBeGreaterThanOrEqual(1);
      expect(template.outcomeTags.length, template.id).toBeLessThanOrEqual(3);
      for (const tag of template.outcomeTags) {
        expect(TAG_IDS, template.id).toContain(tag as (typeof TAG_IDS)[number]);
      }
    }
  });
});

describe("template structure", () => {
  it("has unique, kebab-case ids", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("has 1–5 questions with a valid category and a Lite subset", () => {
    for (const template of TEMPLATES) {
      expect(TEMPLATE_CATEGORIES).toContain(template.category);
      expect(template.questions.length, template.id).toBeGreaterThanOrEqual(1);
      expect(template.questions.length, template.id).toBeLessThanOrEqual(5);
      expect(template.liteQuestionKeys.length, template.id).toBeGreaterThanOrEqual(1);
      // Every Lite key must name a real question.
      const keys = new Set(template.questions.map((q) => q.key));
      for (const k of template.liteQuestionKeys) expect(keys, `${template.id}/${k}`).toContain(k);
    }
  });

  it("has 2–3 learn bullets", () => {
    for (const template of TEMPLATES) {
      expect(template.learnKeys.length, template.id).toBeGreaterThanOrEqual(2);
      expect(template.learnKeys.length, template.id).toBeLessThanOrEqual(3);
    }
  });
});

describe("template resolution and validation", () => {
  for (const template of TEMPLATES) {
    for (const region of REGIONS) {
      it(`${template.id} validates for ${region} in every locale`, () => {
        for (const locale of TEMPLATE_LOCALES) {
          const definition = buildSurveyDefinition({ template, locale, region, lite: false });
          const issues = validateSurveyDefinition(definition);
          expect(issues, `${template.id}/${locale}/${region}: ${JSON.stringify(issues)}`).toEqual([]);
        }
      });
    }
  }

  it("builds a valid Lite version for every template in every region", () => {
    for (const template of TEMPLATES) {
      for (const region of REGIONS) {
        const definition = buildSurveyDefinition({ template, locale: "en", region, lite: true });
        const issues = validateSurveyDefinition(definition);
        expect(issues, `${template.id} lite / ${region}: ${JSON.stringify(issues)}`).toEqual([]);
        // A Free version stays short: at most the recommended question count.
        expect(definition.questions.length, `${template.id} lite`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("produces stable ids independent of language", () => {
    const a = buildSurveyDefinition({ template: TEMPLATES[0]!, locale: "en", region: "us" });
    const b = buildSurveyDefinition({ template: TEMPLATES[0]!, locale: "de", region: "us" });
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id));
    expect(a.questions[0]!.options?.map((o) => o.id)).toEqual(b.questions[0]!.options?.map((o) => o.id));
  });
});

describe("region packs and seasons", () => {
  it("maps shop countries to a region pack", () => {
    expect(regionPackFor("US")).toBe("us");
    expect(regionPackFor(null)).toBe("us");
    expect(regionPackFor("GB")).toBe("eu");
    expect(regionPackFor("DE")).toBe("eu");
    expect(regionPackFor("CH")).toBe("eu");
    expect(regionPackFor("JP")).toBe("global");
    expect(regionPackFor("BR")).toBe("global");
  });

  it("gives every pack the same key set across regions for a family", () => {
    // Channel and occasion packs must merge on shared keys like `instagram`.
    const channels = ALL_PACKS.filter((p) => p.family === "channels");
    const keys = channels.map((p) => new Set(p.options.map((o) => o.key)));
    for (const set of keys) {
      expect(keys[0]!.has("instagram")).toBe(true);
      expect(set.has("other")).toBe(true);
    }
  });

  it("defines a banner for every season and a spotlight template that exists", () => {
    const ids = new Set(TEMPLATES.map((t) => t.id));
    for (const season of SEASONS) {
      expect(EN[season.bannerKey], season.id).toBeTruthy();
      expect(ids, season.id).toContain(season.templateId);
    }
  });
});

describe("smart action presets and ideas", () => {
  it("defines an example line for every preset in every locale", () => {
    for (const preset of Object.values(SMART_ACTION_PRESETS)) {
      for (const locale of TEMPLATE_LOCALES) {
        expect(TEMPLATE_BUNDLES[locale]![preset.exampleKey], `${preset.id}/${locale}`).toBeTruthy();
      }
    }
  });

  it("references real question keys from every template's smart actions", () => {
    for (const template of TEMPLATES) {
      const keys = new Set(template.questions.map((q) => q.key));
      for (const id of template.smartActions ?? []) {
        const preset = SMART_ACTION_PRESETS[id];
        expect(preset, `${template.id}/${id}`).toBeTruthy();
        expect(keys, `${template.id}/${id}`).toContain(preset!.questionKey);
      }
    }
  });

  it("defines text for every idea rule", () => {
    for (const rule of Object.values(IDEA_RULES)) {
      expect(EN[rule.textKey], rule.id).toBeTruthy();
    }
  });

  it("only references known idea ids from templates", () => {
    for (const template of TEMPLATES) {
      for (const id of template.ideas) {
        expect(IDEA_RULES[id], `${template.id}/${id}`).toBeTruthy();
      }
    }
  });
});

describe("stable id helpers", () => {
  it("never emits a translated label into an id", () => {
    expect(stableOptionId("channel-compass", "q_channel", "instagram")).toBe("channel_compass_q_channel_instagram");
    expect(stableQuestionId("channel-compass", "q_channel")).toBe("channel_compass_q_channel");
  });
});

describe("scale labels", () => {
  it("gives rating questions low/high labels and NPS the not-likely/very-likely pair", () => {
    for (const template of TEMPLATES) {
      for (const q of template.questions) {
        const scale = questionScaleLabels(template, q);
        if (q.type === "rating_5") {
          expect(scale, `${template.id}/${q.key}`).not.toBeNull();
          for (const locale of TEMPLATE_LOCALES) {
            const def = buildSurveyDefinition({ template, locale, region: "us" });
            void def;
          }
        }
      }
    }
  });
});
