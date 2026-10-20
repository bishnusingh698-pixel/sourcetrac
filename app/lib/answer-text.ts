import { OTHER_CHANNEL_VALUE, SATISFACTION_OPTIONS } from "@shared/survey-rules";

/**
 * One stored answer as words, for the Responses table and the results CSV.
 *
 * Yes/No and satisfaction questions have fixed options with no stored label,
 * and a Yes/No answer is stored twice (`optionIds: ["yes"]` and
 * `numberValue: 1`). Printing the raw fields gave "yes, 1" and
 * "very_satisfied"; this names the option once, in the merchant's language.
 */

type StoredAnswer = {
  optionIds: string[];
  otherText: string | null;
  numberValue: number | null;
  textValue: string | null;
};

const FIXED_CHOICE_TYPES = new Set(["yes_no", "satisfaction_5"]);

export function fixedOptionLabel(optionId: string, t: (key: string) => string): string | null {
  if (optionId === "yes" || optionId === "no") return t(`surveys.${optionId}`);
  if (SATISFACTION_OPTIONS.some((option) => option.id === optionId)) return t(`surveys.satisfaction_${optionId}`);
  // The built-in "Other" has no Option row and so no stored label.
  if (optionId === OTHER_CHANNEL_VALUE) return t("preview.other_label");
  return null;
}

export function answerParts(
  answer: StoredAnswer,
  questionType: string | undefined,
  labels: ReadonlyMap<string, string>,
  t: (key: string) => string,
): string[] {
  const parts: string[] = [];
  for (const optionId of answer.optionIds) parts.push(labels.get(optionId) ?? fixedOptionLabel(optionId, t) ?? optionId);
  if (answer.otherText) parts.push(answer.otherText);
  if (typeof answer.numberValue === "number") {
    const fixed = questionType ? FIXED_CHOICE_TYPES.has(questionType) : false;
    if (questionType === "yes_no" && answer.optionIds.length === 0) {
      parts.push(t(answer.numberValue === 1 ? "surveys.yes" : "surveys.no"));
    } else if (!fixed || answer.optionIds.length === 0) {
      parts.push(String(answer.numberValue));
    }
  }
  if (answer.textValue) parts.push(answer.textValue);
  return parts;
}
