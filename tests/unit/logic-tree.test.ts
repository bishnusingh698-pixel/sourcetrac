/**
 * Logic tree builder (Phase G).
 *
 * The tree is what the merchant sees in the survey editor's Logic map. It must
 * show each question exactly once, attach it under the question it depends on,
 * label the branch in plain words, and warn on the cases that actually confuse
 * merchants: a removed option, an unreachable question, a conditional required
 * question, and a long survey.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildLogicTree } from "@shared/logic-tree";
import type { SurveyDefinition } from "@shared/survey-rules";

const ROOT = new URL("../..", import.meta.url).pathname;

function survey(questions: SurveyDefinition["questions"]): SurveyDefinition {
  return { questions };
}

describe("buildLogicTree", () => {
  it("puts a question with no rule on the main line", () => {
    const tree = buildLogicTree(
      survey([{ id: "q1", type: "single_choice", text: "How did you hear?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }]),
    );
    expect(tree.roots).toHaveLength(1);
    expect(tree.flat).toHaveLength(1);
    expect(tree.flat[0]!.always).toBe(true);
    expect(tree.flat[0]!.conditionText).toBeNull();
  });

  it("attaches a dependent question under its parent with a readable label", () => {
    const tree = buildLogicTree(
      survey([
        {
          id: "q1",
          type: "single_choice",
          text: "How did you hear?",
          options: [
            { id: "instagram", label: "Instagram" },
            { id: "youtube", label: "YouTube" },
          ],
        },
        {
          id: "q2",
          type: "text",
          text: "Which one?",
          showIf: { questionId: "q1", optionIds: ["instagram", "youtube"] },
        },
      ]),
    );
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.questionId).toBe("q1");
    expect(tree.roots[0]!.children).toHaveLength(1);
    expect(tree.roots[0]!.children[0]!.conditionText).toBe("If the answer is Instagram or YouTube");
    expect(tree.roots[0]!.children[0]!.depth).toBe(1);
  });

  it("labels a numeric range condition", () => {
    const tree = buildLogicTree(
      survey([
        { id: "q1", type: "rating_5", text: "How easy?" },
        { id: "q2", type: "text", text: "What could be easier?", showIf: { questionId: "q1", min: 1, max: 3 } },
      ]),
    );
    expect(tree.roots[0]!.children[0]!.conditionText).toBe("If the score is between 1 and 3");
  });

  it("supports chains and multiple branches from one parent", () => {
    const tree = buildLogicTree(
      survey([
        {
          id: "q1",
          type: "single_choice",
          text: "Q1",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
        },
        { id: "q2", type: "text", text: "Q2", showIf: { questionId: "q1", optionIds: ["a"] } },
        { id: "q3", type: "text", text: "Q3", showIf: { questionId: "q1", optionIds: ["b"] } },
        { id: "q4", type: "text", text: "Q4", showIf: { questionId: "q2", optionIds: [] } },
      ]),
    );
    expect(tree.roots[0]!.children.map((c) => c.questionId).sort()).toEqual(["q2", "q3"]);
    // q4 depends on q2, whose condition is an option list; q4 has an empty
    // option list so it can never match -> unreachable.
    const q4 = tree.flat.find((n) => n.questionId === "q4")!;
    expect(q4.warnings.map((w) => w.code)).toContain("unreachable");
  });

  it("warns when a rule references a removed option", () => {
    const tree = buildLogicTree(
      survey([
        {
          id: "q1",
          type: "single_choice",
          text: "Q1",
          options: [{ id: "a", label: "A", archived: true }, { id: "b", label: "B" }],
        },
        { id: "q2", type: "text", text: "Q2", showIf: { questionId: "q1", optionIds: ["gone"] } },
      ]),
    );
    const q2 = tree.flat.find((n) => n.questionId === "q2")!;
    expect(q2.warnings.map((w) => w.code)).toContain("removed_option");
  });

  it("flags a conditional required question but not an always-required one", () => {
    const tree = buildLogicTree(
      survey([
        { id: "q1", type: "single_choice", text: "Q1", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
        { id: "q2", type: "text", text: "Q2", required: true },
        { id: "q3", type: "text", text: "Q3", required: true, showIf: { questionId: "q1", optionIds: ["a"] } },
      ]),
    );
    const q2 = tree.flat.find((n) => n.questionId === "q2")!;
    const q3 = tree.flat.find((n) => n.questionId === "q3")!;
    expect(q2.warnings.map((w) => w.code)).not.toContain("required_conditional");
    expect(q3.warnings.map((w) => w.code)).toContain("required_conditional");
  });

  it("warns on a long survey and keeps five questions each once", () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      type: "text" as const,
      text: `Question ${i}`,
    }));
    const tree = buildLogicTree(survey(questions));
    expect(tree.flat).toHaveLength(5);
    expect(new Set(tree.flat.map((n) => n.questionId)).size).toBe(5);
    expect(tree.warnings.map((w) => w.code)).toContain("long_survey");
  });

  it("never loops on a corrupt cycle and still surfaces every node", () => {
    // Hand-built corrupt input: q2 depends on q1, q1 depends on q2.
    const tree = buildLogicTree(
      survey([
        { id: "q1", type: "text", text: "Q1", showIf: { questionId: "q2", optionIds: ["x"] } },
        { id: "q2", type: "text", text: "Q2", showIf: { questionId: "q1", optionIds: ["y"] } },
      ]),
    );
    expect(tree.flat).toHaveLength(2);
  });
});

describe("the Logic map does not duplicate the visibility rule", () => {
  it("the simulator imports isQuestionVisible from the shared rules", () => {
    // The plan is explicit: the simulator must use the same predicate as the
    // server. An inline reimplementation would silently drift.
    const source = readFileSync(join(ROOT, "app/components/logic-map.tsx"), "utf8");
    expect(source).toContain("isQuestionVisible");
    expect(source).toMatch(/from "@shared\/survey-rules"/);
  });
});
