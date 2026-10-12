/**
 * Survey logic tree — a pure builder the admin Logic map renders.
 *
 * Given a survey definition, it returns a forest of nodes: each question once,
 * attached to the question it depends on, with a human-readable branch label and
 * any warnings. The UI only renders this output, so the tree logic is unit
 * testable without a DOM and cannot drift from the shared rules.
 *
 * Dependency-free, in the same family as survey-rules.ts. The admin imports it
 * through the `@shared/*` alias; it is never bundled into a checkout extension.
 */

import {
  isNumericType,
  isQuestionType,
  LIMITS,
  resolveOptions,
  satisfactionValue,
  type QuestionType,
  type SurveyDefinition,
  type SurveyOptionDef,
  type SurveyQuestionDef,
} from "./survey-rules";

export type LogicWarning = {
  code: string;
  message: string;
};

export type LogicCondition =
  | { kind: "always" }
  | { kind: "options"; labels: string[]; unknownIds: string[] }
  | { kind: "range"; min?: number; max?: number }
  | { kind: "empty" };

export type LogicNode = {
  questionId: string;
  /** 1-based position in the survey, stable across the tree. */
  index: number;
  text: string;
  type: QuestionType;
  required: boolean;
  archived: boolean;
  /** True when the question has no show-if rule ("Everyone sees this"). */
  always: boolean;
  /** Structured condition the UI localises; `null` when there is no rule. */
  condition: LogicCondition | null;
  /** English fallback label, also used for the accessible name. */
  conditionText: string | null;
  /** The question this node depends on, or null when it sits on the main line. */
  parentId: string | null;
  children: LogicNode[];
  warnings: LogicWarning[];
  /** Depth in the tree (0 = main line). Used to cap mobile indentation. */
  depth: number;
};

export type LogicTree = {
  roots: LogicNode[];
  /** Every node, flattened, in survey order — the accessible list form. */
  flat: LogicNode[];
  warnings: LogicWarning[];
};

/** A trimmed, single-space version of `text`, never longer than `max`. */
function oneLine(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The set of questions that are reachable (can actually be shown to someone). */
function computeReachable(questions: SurveyQuestionDef[]): Set<string> {
  const reachable = new Set<string>();
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]!;
    const cond = q.showIf;
    if (!cond) {
      reachable.add(q.id);
      continue;
    }
    // A condition is reachable when its dependency is reachable and the
    // condition itself is well-formed (references a real earlier question and
    // has a matchable predicate). Otherwise this question can never be shown.
    const earlier = questions.slice(0, i).find((candidate) => candidate.id === cond.questionId);
    if (!earlier || !reachable.has(earlier.id)) continue;
    if ((cond.optionIds && cond.optionIds.length > 0) || typeof cond.min === "number" || typeof cond.max === "number") {
      reachable.add(q.id);
    }
  }
  return reachable;
}

/** Plain-language description of a show-if condition (English fallback). */
function describeCondition(
  question: SurveyQuestionDef,
  parent: SurveyQuestionDef | undefined,
): string {
  const cond = conditionFor(question, parent);
  if (cond.kind === "always" || cond.kind === "empty") return "If an answer is chosen";
  if (cond.kind === "range") {
    if (typeof cond.min === "number" && typeof cond.max === "number") {
      return `If the score is between ${cond.min} and ${cond.max}`;
    }
    if (typeof cond.min === "number") return `If the score is ${cond.min} or higher`;
    return `If the score is ${cond.max} or lower`;
  }
  const labels = cond.labels;
  if (labels.length === 0) return "If an answer is chosen";
  if (labels.length === 1) return `If the answer is ${labels[0]}`;
  if (labels.length === 2) return `If the answer is ${labels[0]} or ${labels[1]}`;
  return `If the answer is ${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}

/** Structured condition plus resolved labels for the UI and the fallback text. */
function conditionFor(
  question: SurveyQuestionDef,
  parent: SurveyQuestionDef | undefined,
): LogicCondition {
  const cond = question.showIf;
  if (!cond) return { kind: "always" };

  if (typeof cond.min === "number" || typeof cond.max === "number") {
    const range: Extract<LogicCondition, { kind: "range" }> = { kind: "range" };
    if (typeof cond.min === "number") range.min = cond.min;
    if (typeof cond.max === "number") range.max = cond.max;
    return range;
  }

  const ids = cond.optionIds ?? [];
  if (ids.length === 0) return { kind: "empty" };

  const labels: string[] = [];
  const unknownIds: string[] = [];
  for (const id of ids) {
    const label = resolveOptionLabel(parent, id);
    if (label === null) unknownIds.push(id);
    else labels.push(label);
  }
  return { kind: "options", labels, unknownIds };
}

/** The display label for an option id, or null when the option no longer exists. */
function resolveOptionLabel(parent: SurveyQuestionDef | undefined, id: string): string | null {
  if (!parent) return null;
  if (parent.type === "yes_no") return id === "yes" ? "Yes" : id === "no" ? "No" : null;
  if (parent.type === "satisfaction_5") return humanSatisfaction(id);
  const option = (parent.options ?? []).find((o) => o.id === id);
  return option ? option.label : null;
}

function humanSatisfaction(id: string): string {
  if (id === "very_dissatisfied") return "Very dissatisfied";
  if (id === "dissatisfied") return "Dissatisfied";
  if (id === "neutral") return "Neutral";
  if (id === "satisfied") return "Satisfied";
  if (id === "very_satisfied") return "Very satisfied";
  return id;
}

/**
 * Build the tree.
 *
 * Every question appears exactly once. A question with no rule is a root; a
 * question with a rule becomes a child of the question it depends on. Cycles are
 * impossible because show-if may only reference an earlier question (enforced by
 * `validateSurveyDefinition`), but a defensive orphan pass keeps a corrupted row
 * from dropping nodes.
 */
export function buildLogicTree(survey: SurveyDefinition): LogicTree {
  const questions = survey.questions ?? [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const reachable = computeReachable(questions);

  const nodes = new Map<string, LogicNode>();
  questions.forEach((question, i) => {
    const parent = question.showIf ? byId.get(question.showIf.questionId) : undefined;
    nodes.set(question.id, {
      questionId: question.id,
      index: i + 1,
      text: oneLine(question.text),
      type: isQuestionType(question.type) ? question.type : "single_choice",
      required: question.required === true,
      archived: question.archived === true,
      always: !question.showIf,
      condition: question.showIf ? conditionFor(question, parent) : null,
      conditionText: question.showIf ? describeCondition(question, parent) : null,
      parentId: parent ? parent.id : null,
      children: [],
      warnings: [],
      depth: 0,
    });
  });

  const roots: LogicNode[] = [];
  for (const question of questions) {
    const node = nodes.get(question.id)!;
    // Attach to the parent only when the reference resolves and is acyclic.
    if (node.parentId && isAncestorSafe(nodes, node.parentId, question.id)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      if (node.parentId) node.parentId = null; // defensive: orphan
      roots.push(node);
    }
  }

  // Warn on every node, then flatten in survey order.
  const flat: LogicNode[] = [];
  const assignDepth = (node: LogicNode, depth: number) => {
    node.depth = depth;
    node.warnings = nodeWarnings(node, byId, reachable);
    flat.push(node);
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);

  // A node whose parent chain never reached it (corrupt) is still surfaced.
  for (const node of nodes.values()) if (!flat.includes(node)) assignDepth(node, 0);

  flat.sort((a, b) => a.index - b.index);

  const warnings: LogicWarning[] = [];
  if (questions.length > LIMITS.RECOMMENDED_MAX_QUESTIONS) {
    warnings.push({
      code: "long_survey",
      message: `Long survey: ${questions.length} questions. Shorter surveys usually get more answers.`,
    });
  }

  return { roots, flat, warnings };
}

/** Guard against a corrupt cycle: never attach a node under its own descendant. */
function isAncestorSafe(nodes: Map<string, LogicNode>, parentId: string, childId: string): boolean {
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === childId) return false;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = nodes.get(cursor)?.parentId ?? null;
  }
  return true;
}

function nodeWarnings(
  node: LogicNode,
  byId: Map<string, SurveyQuestionDef>,
  reachable: Set<string>,
): LogicWarning[] {
  const warnings: LogicWarning[] = [];
  const question = byId.get(node.questionId);
  if (!question) return warnings;

  if (!reachable.has(node.questionId)) {
    warnings.push({
      code: "unreachable",
      message: "This question can never be shown.",
    });
  }

  // A condition that references an option that no longer exists.
  if (question.showIf) {
    const parent = byId.get(question.showIf.questionId);
    const ids = question.showIf.optionIds ?? [];
    if (parent && ids.length > 0) {
      const allowed = allowedOptionIds(parent);
      const missing = ids.filter((id) => !allowed.has(id));
      if (missing.length > 0) {
        warnings.push({
          code: "removed_option",
          message: "This rule refers to an answer option that was removed.",
        });
      }
    }
  }

  if (node.required && !node.always) {
    warnings.push({
      code: "required_conditional",
      message: "This question is required but only some shoppers see it. Hidden questions are skipped.",
    });
  }

  return warnings;
}

/** Option ids a show-if rule on `parent` may legitimately reference. */
function allowedOptionIds(parent: SurveyQuestionDef): Set<string> {
  if (parent.type === "yes_no") return new Set(["yes", "no"]);
  if (parent.type === "satisfaction_5") {
    return new Set(["very_dissatisfied", "dissatisfied", "neutral", "satisfied", "very_satisfied"]);
  }
  return new Set(resolveOptions(parent, { includeArchived: true }).map((o) => o.id));
}

/** Exported for the simulator and tests; the same predicate the server uses. */
export { isNumericType, satisfactionValue };
export type { SurveyOptionDef };
