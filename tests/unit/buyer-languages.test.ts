import { describe, expect, it } from "vitest";

import { localizeSurvey, matchLocale } from "../../extensions/shared/src/use-multi-survey";
import type { CompiledSurvey } from "../../extensions/shared/src/survey-logic";

/** B10/B11: a survey translated into Arabic or Hebrew reaches those buyers. */
const survey: CompiledSurvey = {
  id: "s",
  version: 1,
  placements: ["thank_you"],
  layout: "all",
  title: "Quick question",
  intro: null,
  buttonLabel: "Submit",
  thankYouText: "Thanks!",
  translations: { ar: { title: "سؤال سريع", buttonLabel: "إرسال" }, he: { title: "שאלה קצרה" } },
  design: { scaleLowLabel: "Meh", scaleHighLabel: "Wow" },
  questions: [
    {
      id: "q1",
      type: "single_choice",
      text: "How did you hear about us?",
      textMultiline: false,
      required: true,
      randomizeOptions: false,
      allowOther: false,
      translations: { ar: { text: "كيف سمعت عنا؟" } },
      options: [{ id: "a", label: "Friend", isOther: false, translations: { ar: "صديق" } }],
    },
  ],
};

describe("buyer languages", () => {
  it("matches a regional checkout language to the translation", () => {
    expect(matchLocale("ar-SA", ["de", "ar", "he"])).toBe("ar");
    expect(matchLocale("he-IL", ["de", "ar", "he"])).toBe("he");
    expect(matchLocale("ko-KR", ["de", "ar"])).toBeNull();
  });

  it("shows the Arabic wording, falling back field by field to the default", () => {
    const ar = localizeSurvey(survey, "ar-AE");
    expect(ar.title).toBe("سؤال سريع");
    expect(ar.buttonLabel).toBe("إرسال");
    // Not translated: the merchant's own wording stays.
    expect(ar.thankYouText).toBe("Thanks!");
    expect(ar.questions[0]?.text).toBe("كيف سمعت عنا؟");
    expect(ar.questions[0]?.options[0]?.label).toBe("صديق");

    const he = localizeSurvey(survey, "he");
    expect(he.title).toBe("שאלה קצרה");
    expect(he.questions[0]?.text).toBe("How did you hear about us?");
  });

  it("translates the merchant's own scale words when a translation exists", () => {
    const translated = localizeSurvey(
      { ...survey, translations: { de: { scaleLowLabel: "Naja", scaleHighLabel: "Toll" } } },
      "de-DE",
    );
    expect(translated.design?.scaleLowLabel).toBe("Naja");
    expect(translated.design?.scaleHighLabel).toBe("Toll");
    expect(localizeSurvey(survey, "fr").design?.scaleLowLabel).toBe("Meh");
  });
});
