/**
 * Phase 3 acceptance: every template must produce a survey the shared validator
 * accepts, and every validator code the editor renders must have a translation
 * key in every shipped locale.
 *
 * Both are the kind of failure nothing else catches: a template with 11 options
 * or a duplicated slug still opens in the picker and only fails when the
 * merchant saves, and a missing `surveys.validation_*` key renders the raw key
 * on a field the merchant is trying to fix.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESOURCES } from "~/lib/i18n";
import { SURVEY_TEMPLATES, findTemplate } from "@shared/survey-templates";
import { LIMITS, validateSurveyDefinition } from "@shared/survey-rules";

/**
 * Every `code` `validateSurveyDefinition` can emit, read from its source so a
 * new rule fails this test until it is translated.
 *
 * Scoped to that one function on purpose: `validateResponse`'s codes describe a
 * buyer's answer and are rendered by the extension's own `MESSAGES`, not by the
 * merchant's editor.
 */
function validatorCodes(): string[] {
  const source = readFileSync(join(process.cwd(), "shared/survey-rules.ts"), "utf8");
  const start = source.indexOf("export function validateSurveyDefinition");
  const end = source.indexOf("export function validateResponse", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  const codes = new Set<string>();
  for (const match of body.matchAll(/issue\(\s*[`"][^`"]*[`"]\s*,\s*"([a-z_]+)"/g)) {
    if (match[1]) codes.add(match[1]);
  }
  return [...codes];
}

function flatten(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

describe("survey templates", () => {
  it("ships the twelve Appendix A templates", () => {
    expect(SURVEY_TEMPLATES.length).toBe(12);
  });

  it("gives every template a unique id", () => {
    const ids = SURVEY_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const template of SURVEY_TEMPLATES) {
    it(`${template.id} passes the shared validator`, () => {
      const issues = validateSurveyDefinition(template.survey);
      expect(issues, `${template.id}: ${issues.map((i) => `${i.path} ${i.code}`).join("; ")}`).toEqual([]);
    });

    it(`${template.id} stays within the option limits`, () => {
      for (const question of template.survey.questions) {
        const count = (question.options ?? []).length;
        if (count > 0) {
          expect(count).toBeGreaterThanOrEqual(LIMITS.MIN_OPTIONS);
          expect(count).toBeLessThanOrEqual(LIMITS.MAX_OPTIONS);
        }
      }
    });
  }

  it("resolves a known id and rejects an unknown one", () => {
    expect(findTemplate("how-did-you-hear")).toBeDefined();
    expect(findTemplate("no-such-template")).toBeUndefined();
  });
});

describe("validator codes are translatable", () => {
  const codes = validatorCodes();

  it("found codes to check", () => {
    // Guards the scanner: an empty set would make the assertion below vacuous.
    expect(codes.length).toBeGreaterThan(10);
  });

  for (const [locale, bundle] of Object.entries(RESOURCES)) {
    it(`${locale} defines a surveys.validation_* key for every code`, () => {
      const keys = flatten((bundle as { translation: unknown }).translation);
      const missing = codes.filter((code) => !keys.has(`surveys.validation_${code}`));
      expect(missing, `${locale} missing: ${missing.join(", ")}`).toEqual([]);
    });
  }
});
