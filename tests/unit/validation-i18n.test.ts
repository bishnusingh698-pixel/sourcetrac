import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ValidationError } from "~/lib/errors";
import { createTranslator, LANGUAGES } from "~/lib/i18n";
import {
  DEFAULT_OPTIONS,
  DEFAULT_QUESTION_TEXT,
  isUntouchedDefaultSurvey,
  MAX_OPTION_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  validateSurveySettings,
  validationI18n,
} from "~/lib/settings";

/**
 * Validation runs on the server but is read by the merchant in their language.
 * These errors used to carry English text only, so a merchant using the admin in
 * Japanese got "Add at least 6 answer options." in the middle of a Japanese
 * page. Each error now carries translation keys, and this checks that every
 * one of them resolves to real text, with its numbers filled in, in every
 * language.
 */

const options = DEFAULT_OPTIONS.map(({ label, emoji }) => ({ label, emoji }));

const CASES: Array<{ name: string; input: Parameters<typeof validateSurveySettings>[0]; field: string }> = [
  { name: "missing question", input: { questionText: "   ", options, allowOther: false }, field: "questionText" },
  {
    name: "question too long",
    input: { questionText: "x".repeat(MAX_QUESTION_LENGTH + 3), options, allowOther: false },
    field: "questionText",
  },
  { name: "options not a list", input: { questionText: "Q", options: null, allowOther: false }, field: "options" },
  { name: "too few options", input: { questionText: "Q", options: options.slice(0, 2), allowOther: false }, field: "options" },
  {
    name: "too many options",
    input: {
      questionText: "Q",
      options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ label: `Channel ${i}`, emoji: "" })),
      allowOther: false,
    },
    field: "options",
  },
  {
    name: "empty label",
    input: { questionText: "Q", options: [...options.slice(0, 5), { label: " ", emoji: "" }], allowOther: false },
    field: "options.5.label",
  },
  {
    name: "label too long",
    input: {
      questionText: "Q",
      options: [...options.slice(0, 5), { label: "y".repeat(MAX_OPTION_LABEL_LENGTH + 1), emoji: "" }],
      allowOther: false,
    },
    field: "options.5.label",
  },
  {
    name: "invalid emoji",
    input: { questionText: "Q", options: [...options.slice(0, 5), { label: "Radio", emoji: "abc" }], allowOther: false },
    field: "options.5.emoji",
  },
  {
    name: "duplicate option",
    input: { questionText: "Q", options: [...options.slice(0, 5), { label: "instagram", emoji: "" }], allowOther: false },
    field: "options.5.label",
  },
];

function capture(input: Parameters<typeof validateSurveySettings>[0]): ValidationError {
  try {
    validateSurveySettings(input);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected a ValidationError");
}

describe("validation errors are translatable", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} carries keys that resolve in every language`, () => {
      const error = capture(testCase.input);
      expect(error.fields.field).toBe(testCase.field);

      const i18n = validationI18n(error);
      expect(i18n).not.toBeNull();

      for (const { code } of LANGUAGES) {
        const t = createTranslator(code);
        for (const text of [i18n!.message, i18n!.hint]) {
          if (!text) continue;
          const rendered = t(text.key, text.params);
          // A missing key renders as the key; a missing param leaves braces.
          expect(rendered, `${code} ${text.key}`).not.toBe(text.key);
          expect(rendered, `${code} ${text.key}`).not.toMatch(/{{\w+}}/);
        }
      }
    });
  }

  it("fills in the numbers, not just the words", () => {
    const error = capture(CASES[1]!.input);
    const hint = validationI18n(error)!.hint!;
    expect(createTranslator("de")(hint.key, hint.params)).toContain("3");
  });
});

describe("translated survey defaults", () => {
  it("recognises the install defaults", () => {
    expect(isUntouchedDefaultSurvey(DEFAULT_QUESTION_TEXT, DEFAULT_OPTIONS)).toBe(true);
  });

  it("stops offering them once the merchant has reworded anything", () => {
    expect(isUntouchedDefaultSurvey("Where did you find us?", DEFAULT_OPTIONS)).toBe(false);
    const renamed = DEFAULT_OPTIONS.map((o, i) => (i === 0 ? { ...o, label: "Google" } : o));
    expect(isUntouchedDefaultSurvey(DEFAULT_QUESTION_TEXT, renamed)).toBe(false);
    expect(isUntouchedDefaultSurvey(DEFAULT_QUESTION_TEXT, DEFAULT_OPTIONS.slice(1))).toBe(false);
  });

  it("matches the question the database seeds", () => {
    // If these drift, no shop is ever recognised as untouched and the offer
    // silently never appears.
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(schema).toContain(`questionText           String   @default("${DEFAULT_QUESTION_TEXT}")`);
  });

  it("has a translated label for every default option in every language", () => {
    for (const { code } of LANGUAGES) {
      const t = createTranslator(code);
      for (const key of ["survey_defaults.question", ...DEFAULT_OPTIONS.map((o) => `survey_defaults.${o.value}`)]) {
        expect(t(key), `${code} ${key}`).not.toBe(key);
      }
    }
  });
});
