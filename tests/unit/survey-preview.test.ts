/**
 * The editor's survey preview can be clicked through like a buyer would.
 *
 * Mounted for real: follow-ups appear only after the answer that triggers
 * them, Submit waits for required answers and a filled-in "Other", a
 * one-question survey finishes on the tap, and Start again clears it all.
 */
import "../helpers/dom-globals";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SurveyPreview } from "~/components/survey-preview";
import { createTranslator } from "~/lib/i18n";
import { previewComplete, previewVisibleQuestions, tapSubmits } from "~/lib/preview-state";
import type { EditorQuestion, EditorSurvey } from "~/lib/surveys.server";
import { DEFAULT_DESIGN } from "@shared/survey-rules";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = createTranslator("en");

function option(id: string, label: string) {
  return { id, label, isOther: false, exclusive: false, archived: false, translations: {} };
}

const channel: EditorQuestion = {
  id: "q1",
  type: "single_choice",
  text: "How did you hear about us?",
  required: true,
  allowOther: true,
  options: [option("insta", "Instagram"), option("google", "Google")],
};

const followUp: EditorQuestion = {
  id: "q2",
  type: "text",
  text: "Which post did you see?",
  required: false,
  options: [],
  showIf: { questionId: "q1", optionIds: ["insta"] },
};

function surveyOf(questions: EditorQuestion[], layout: "all" | "one_by_one" = "all"): EditorSurvey {
  return {
    id: "s1",
    name: "Test",
    status: "draft",
    priority: 0,
    placements: ["thank_you"],
    layout,
    title: "Quick question",
    intro: null,
    buttonLabel: "Send",
    thankYouText: "Thanks, that helps!",
    channelReportQuestionId: null,
    targeting: {},
    syncOptions: {},
    translations: {},
    version: 1,
    responseCount: 0,
    templateId: null,
    templateVersion: null,
    rotation: false,
    rotationWeight: 2,
    learnAndStop: false,
    design: { ...DEFAULT_DESIGN, layout },
    draftUpdatedAt: null,
    hasDraft: false,
    revision: 0,
    questions,
    updatedAt: new Date(0).toISOString(),
  } as EditorSurvey;
}

let root: Root | null = null;
let container: HTMLElement;

function mount(survey: EditorSurvey) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(SurveyPreview, { survey, t })));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

const text = () => container.textContent ?? "";

function click(match: (el: Element) => boolean) {
  const el = [...container.querySelectorAll("button, s-button")].find(match);
  if (!el) throw new Error(`nothing to click in: ${text()}`);
  act(() => {
    el.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
  });
}

const byText = (value: string) => (el: Element) => el.textContent?.trim().endsWith(value) === true;

function submitDisabled(label: string): boolean {
  const button = [...container.querySelectorAll("s-button")].find(byText(label));
  return button?.hasAttribute("disabled") === true;
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}

describe("interactive survey preview", () => {
  it("shows a follow-up only after the answer that triggers it, then thanks the buyer", () => {
    mount(surveyOf([channel, followUp]));
    expect(text()).not.toContain("Which post did you see?");
    expect(submitDisabled("Send")).toBe(true);

    click(byText("Google"));
    expect(text()).not.toContain("Which post did you see?");
    expect(submitDisabled("Send")).toBe(false);

    click(byText("Instagram"));
    expect(text()).toContain("Which post did you see?");

    click(byText("Send"));
    expect(text()).toContain("Thanks, that helps!");

    click(byText("Start again"));
    expect(text()).toContain("How did you hear about us?");
    expect(text()).not.toContain("Which post did you see?");
  });

  it("waits for the buyer's own words when Other is chosen", () => {
    mount(surveyOf([channel, followUp]));
    click(byText("Other"));
    expect(submitDisabled("Send")).toBe(true);
    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    type(input, "A podcast");
    expect(submitDisabled("Send")).toBe(false);
  });

  it("finishes a one-question survey on the tap, like checkout", () => {
    mount(surveyOf([channel]));
    click(byText("Instagram"));
    expect(text()).toContain("Thanks, that helps!");
  });

  it("steps through one question at a time", () => {
    mount(surveyOf([channel, followUp], "one_by_one"));
    expect(text()).not.toContain("1 of");
    click(byText("Instagram"));
    expect(text()).toContain("1 of 2");
    click(byText("Next"));
    expect(text()).toContain("Which post did you see?");
    expect(text()).not.toContain("How did you hear about us?");
    click(byText("Back"));
    expect(text()).toContain("How did you hear about us?");
  });
});

describe("preview rules", () => {
  it("ignores an answer left on a question that is now hidden", () => {
    const third: EditorQuestion = {
      id: "q3",
      type: "yes_no",
      text: "Would you recommend it?",
      options: [],
      showIf: { questionId: "q2", optionIds: ["yes"] },
    };
    const second: EditorQuestion = { ...followUp, type: "yes_no", showIf: { questionId: "q1", optionIds: ["insta"] } };
    const answers = {
      q1: { questionId: "q1", optionIds: ["google"] },
      q2: { questionId: "q2", optionIds: ["yes"], numberValue: 1 },
    };
    expect(previewVisibleQuestions([channel, second, third], answers).map((q) => q.id)).toEqual(["q1"]);
  });

  it("needs every required question and the multiple-choice limits", () => {
    const multi: EditorQuestion = {
      id: "m",
      type: "multi_choice",
      text: "Pick two",
      required: true,
      minSelections: 2,
      options: [option("a", "A"), option("b", "B"), option("c", "C")],
    };
    expect(previewComplete([multi], {})).toBe(false);
    expect(previewComplete([multi], { m: { questionId: "m", optionIds: ["a"] } })).toBe(false);
    expect(previewComplete([multi], { m: { questionId: "m", optionIds: ["a", "b"] } })).toBe(true);
  });

  it("only a single tap question laid out in full submits on the tap", () => {
    const tap = { questionId: "q1", optionIds: ["insta"] };
    expect(tapSubmits([channel], "all", channel, tap)).toBe(true);
    expect(tapSubmits([channel], "one_by_one", channel, tap)).toBe(false);
    expect(tapSubmits([channel, followUp], "all", channel, tap)).toBe(false);
    expect(tapSubmits([channel], "all", channel, { questionId: "q1", optionIds: ["other"] })).toBe(false);
  });
});
