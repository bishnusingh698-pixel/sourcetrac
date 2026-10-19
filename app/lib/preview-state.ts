import {
  isQuestionVisible,
  OTHER_CHANNEL_VALUE,
  resolveOptions,
  type AnswerInput,
  type SurveyQuestionDef,
} from "@shared/survey-rules";

/**
 * The rules behind the clickable survey preview in the editor.
 *
 * The same ones the checkout block follows, so what a merchant clicks through
 * in the preview is what a buyer gets: follow-ups appear only after the answer
 * that triggers them, Submit stays off until every required question is
 * answered, and a one-question survey answered with a tap is done at once.
 * Visibility goes through the shared `isQuestionVisible`.
 */

export type PreviewAnswers = Record<string, AnswerInput>;

/**
 * Visible questions in order. As on the server, a condition only reads answers
 * to questions that are themselves visible, so an answer left behind on a
 * question that became hidden cannot keep its follow-ups showing.
 */
export function previewVisibleQuestions<Q extends SurveyQuestionDef>(questions: readonly Q[], answers: PreviewAnswers): Q[] {
  const counted: AnswerInput[] = [];
  const visible: Q[] = [];
  for (const question of questions) {
    if (!isQuestionVisible(question, counted)) continue;
    visible.push(question);
    const answer = answers[question.id];
    if (answer) counted.push(answer);
  }
  return visible;
}

function hasContent(answer: AnswerInput | undefined): boolean {
  if (!answer) return false;
  return (
    (answer.optionIds?.length ?? 0) > 0 ||
    typeof answer.numberValue === "number" ||
    (answer.textValue?.trim().length ?? 0) > 0
  );
}

/** Whether an option id is the free-text "Other" choice. */
export function isOtherOption(question: SurveyQuestionDef, optionId: string | undefined): boolean {
  if (!optionId) return false;
  return optionId === OTHER_CHANNEL_VALUE || resolveOptions(question).some((o) => o.id === optionId && o.isOther);
}

/**
 * Whether Submit can be pressed: every visible required question answered,
 * "Other" filled in, and at least one answer (the server refuses an empty set),
 * the same rule as the checkout block's `complete`.
 */
export function previewComplete(visible: readonly SurveyQuestionDef[], answers: PreviewAnswers): boolean {
  let answered = 0;
  for (const question of visible) {
    const answer = answers[question.id];
    if (!hasContent(answer)) {
      if (question.required) return false;
      continue;
    }
    answered += 1;
    const chosen = answer?.optionIds ?? [];
    if (chosen.some((id) => isOtherOption(question, id)) && (answer?.otherText?.trim().length ?? 0) === 0) return false;
    if (question.type === "multi_choice") {
      const count = new Set(chosen).size;
      if (typeof question.minSelections === "number" && count < question.minSelections) return false;
      if (typeof question.maxSelections === "number" && count > question.maxSelections) return false;
    }
  }
  return answered > 0;
}

/** Question types answered with one tap. A survey of one such question submits on the tap. */
const SINGLE_TAP = new Set(["single_choice", "dropdown", "yes_no", "rating_5", "nps", "satisfaction_5"]);

/** Whether this tap finishes the survey, as it does in checkout. */
export function tapSubmits(
  questions: readonly SurveyQuestionDef[],
  layout: "all" | "one_by_one",
  question: SurveyQuestionDef,
  answer: AnswerInput,
): boolean {
  if (questions.length !== 1 || layout !== "all") return false;
  if (!SINGLE_TAP.has(question.type)) return false;
  return !isOtherOption(question, answer.optionIds?.[0]);
}
