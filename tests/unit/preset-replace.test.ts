/**
 * "Use answers for a country" in the survey editor, mounted for real.
 *
 * - Replacing the merchant's own answers asks first, naming the answers that
 *   would go (R4). Replacing nothing of theirs applies at once.
 * - Each question's country list is its own radio group (R5): with one shared
 *   name, picking a country under one question unticked it under another.
 */
import "../helpers/dom-globals";

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuestionList } from "~/components/survey-editor";
import { presetLabels } from "~/lib/channel-presets.server";
import { createTranslator } from "~/lib/i18n";
import type { EditorSurvey } from "~/lib/surveys.server";
import { DEFAULT_DESIGN, LIMITS } from "@shared/survey-rules";

const t = createTranslator("en");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Question = EditorSurvey["questions"][number];

function choiceQuestion(id: string, labels: string[]): Question {
  return {
    id,
    type: "single_choice",
    text: "How did you hear about us?",
    required: true,
    allowOther: false,
    translations: {},
    options: labels.map((label, i) => ({ id: `${id}-o${i}`, label, isOther: false, exclusive: false, archived: false, translations: {} })),
  };
}

function survey(questions: Question[]): EditorSurvey {
  return {
    id: "s1", name: "S", status: "draft", priority: 0, placements: ["thank_you"], layout: "all", title: "T", intro: null,
    buttonLabel: "B", thankYouText: "Y", channelReportQuestionId: null, targeting: {}, syncOptions: {}, translations: {},
    version: 1, responseCount: 0, templateId: null, templateVersion: null, rotation: false, rotationWeight: 2,
    learnAndStop: false, autoPausedAt: null, pausedAutomatically: false, design: DEFAULT_DESIGN, draftUpdatedAt: null,
    hasDraft: false, revision: 0, updatedAt: "", questions,
  };
}

let root: Root;
let container: HTMLElement;
const state: { draft: EditorSurvey | null } = { draft: null };

function Harness({ initial }: { initial: EditorSurvey }) {
  const [draft, setDraft] = useState(initial);
  state.draft = draft;
  return createElement(QuestionList, {
    draft,
    update: (patch: Partial<EditorSurvey>) => setDraft((d) => ({ ...d, ...patch })),
    t,
    limits: LIMITS,
    errors: new Map(),
    plan: "growth",
    presets: { labels: presetLabels("en"), shopCountry: "US", language: "en" },
  });
}

function mount(initial: EditorSurvey) {
  act(() => root.render(createElement(Harness, { initial })));
}

function buttons(text: string): HTMLElement[] {
  return [...container.querySelectorAll("s-button")].filter((b) => b.textContent === text) as HTMLElement[];
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
  });
}

const labels = () => state.draft!.questions[0]!.options.map((o) => o.label);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("replacing a question's answers with a country's (R4)", () => {
  it("asks first, naming the merchant's answers that would be removed", () => {
    mount(survey([choiceQuestion("q1", ["Instagram", "Our newsletter", "Radio ad"])]));
    click(buttons("Replace my answers")[0]!);

    // Nothing changed yet; the question names what would go.
    expect(labels()).toEqual(["Instagram", "Our newsletter", "Radio ad"]);
    expect(container.textContent).toContain("This removes your answers Our newsletter, Radio ad from this question.");

    click(buttons("Keep my answers")[0]!);
    expect(labels()).toEqual(["Instagram", "Our newsletter", "Radio ad"]);
    expect(container.textContent).not.toContain("This removes your answers");

    click(buttons("Replace my answers")[0]!);
    click(buttons("Replace anyway")[0]!);
    expect(labels()).toContain("TikTok");
    expect(labels()).not.toContain("Radio ad");
    // The answer the preset also has keeps its id, so its results stay with it.
    expect(state.draft!.questions[0]!.options.find((o) => o.label === "Instagram")?.id).toBe("q1-o0");
  });

  it("replaces at once when none of the merchant's answers would be removed", () => {
    mount(survey([choiceQuestion("q1", ["Instagram", "TikTok"])]));
    click(buttons("Replace my answers")[0]!);
    expect(container.textContent).not.toContain("This removes your answers");
    expect(labels().length).toBeGreaterThan(2);
  });
});

describe("country lists in the editor (R5)", () => {
  it("gives each question's list its own radio group", () => {
    mount(survey([choiceQuestion("q1", ["A", "B"]), choiceQuestion("q2", ["C", "D"])]));
    const radios = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    const names = new Set(radios.map((r) => r.name));
    expect(names.size).toBe(2);
    expect([...names].every((name) => name.length > 0)).toBe(true);
  });
});
