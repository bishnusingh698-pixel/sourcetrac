/**
 * Plain-language summaries of a survey's structure, for the template cards and
 * the editor's preview.
 *
 * Dependency-free and pure. It returns ids and numbers, never sentences: the
 * admin turns them into words in the merchant's language.
 */

import { questionHasMerchantOptions, type SurveyQuestionDef } from "./survey-rules";

export type FollowUp = {
  /** 1-based position of the question this one depends on. */
  parentNumber: number;
  /**
   * For a choice parent: the option ids that show this question, with the
   * merchant's label when the option is one of theirs (null for fixed options
   * such as Yes / No, which the admin labels itself).
   */
  options: Array<{ id: string; label: string | null }>;
  /** For a score parent (rating, NPS): the range that shows this question. */
  min: number | null;
  max: number | null;
};

/**
 * When `question` is a follow-up, what makes it appear; null when it is always
 * asked. A condition naming a question that is not in the list (deleted, or not
 * saved yet) is reported with `parentNumber` 0 rather than guessed.
 */
export function describeFollowUp(
  question: Pick<SurveyQuestionDef, "showIf">,
  questions: ReadonlyArray<Pick<SurveyQuestionDef, "id" | "type" | "options">>,
): FollowUp | null {
  const cond = question.showIf;
  if (!cond?.questionId) return null;
  const index = questions.findIndex((q) => q.id === cond.questionId);
  const parent = index >= 0 ? questions[index] : undefined;
  const merchantLabels = new Map(
    parent && questionHasMerchantOptions(parent.type) ? (parent.options ?? []).map((o) => [o.id, o.label] as const) : [],
  );
  return {
    parentNumber: index + 1,
    options: (cond.optionIds ?? []).map((id) => ({ id, label: merchantLabels.get(id) ?? null })),
    min: typeof cond.min === "number" ? cond.min : null,
    max: typeof cond.max === "number" ? cond.max : null,
  };
}
