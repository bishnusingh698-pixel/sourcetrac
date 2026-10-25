import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuestionList } from "~/components/survey-editor";
import { presetLabels } from "~/lib/channel-presets.server";
import { createTranslator } from "~/lib/i18n";
import type { EditorSurvey } from "~/lib/surveys.server";
import { DEFAULT_DESIGN, LIMITS, validateSurveyDefinition } from "@shared/survey-rules";

const t = createTranslator("en");

function survey(regular: number, withOther: boolean): EditorSurvey {
  const options = Array.from({ length: regular }, (_, i) => ({
    id: `o${i}`,
    label: `Answer ${i}`,
    isOther: false,
    exclusive: false,
    archived: false,
    translations: {},
  }));
  if (withOther) options.push({ id: "other", label: "Other", isOther: true, exclusive: false, archived: false, translations: {} });
  return {
    id: "s1", name: "S", status: "draft", priority: 0, placements: ["thank_you"], layout: "all", title: "T", intro: null,
    buttonLabel: "B", thankYouText: "Y", channelReportQuestionId: "q1", targeting: {}, syncOptions: {}, translations: {},
    version: 1, responseCount: 0, templateId: null, templateVersion: null, rotation: false, rotationWeight: 2,
    learnAndStop: false, autoPausedAt: null, pausedAutomatically: false, design: DEFAULT_DESIGN, draftUpdatedAt: null,
    hasDraft: false, revision: 0, updatedAt: "",
    questions: [{ id: "q1", type: "single_choice", text: "How?", required: true, allowOther: false, translations: {}, options }],
  };
}

function render(draft: EditorSurvey): string {
  return renderToStaticMarkup(
    <QuestionList
      draft={draft}
      update={() => {}}
      t={t}
      limits={LIMITS}
      errors={new Map()}
      plan="growth"
      presets={{ labels: presetLabels("en"), shopCountry: "US", language: "en" }}
    />,
  );
}

/** The `<s-button>` whose text is `label`, as rendered. */
function button(html: string, label: string): string {
  const match = new RegExp(`<s-button[^>]*>${label}</s-button>`).exec(html);
  expect(match, `button "${label}"`).not.toBeNull();
  return match![0];
}

describe("the answer limit counts an 'Other (please specify)' option (R1)", () => {
  it("is what the server enforces: ten answers plus Other is refused", () => {
    const draft = survey(LIMITS.MAX_OPTIONS, true);
    const codes = validateSurveyDefinition(draft as never).map((issue) => issue.code);
    expect(codes).toContain("options_too_many");
  });

  it("stops adding answers one early when the question has an Other option", () => {
    const html = render(survey(LIMITS.MAX_OPTIONS - 1, true));
    expect(button(html, "Add answer")).toContain("disabled");
    expect(html).toContain(`${LIMITS.MAX_OPTIONS - 1} of ${LIMITS.MAX_OPTIONS - 1} answers`);
  });

  it("still allows the full limit without one", () => {
    const html = render(survey(LIMITS.MAX_OPTIONS - 1, false));
    expect(button(html, "Add answer")).not.toContain("disabled");
    expect(html).toContain(`${LIMITS.MAX_OPTIONS - 1} of ${LIMITS.MAX_OPTIONS} answers`);
  });

  it("never offers country presets past the limit", () => {
    // Nine of ten slots used by the merchant's answers plus Other: nothing fits.
    const html = render(survey(LIMITS.MAX_OPTIONS - 1, true));
    expect(html).toContain("This question already has the most answers it can hold");
  });
});
