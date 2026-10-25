import { useMemo, useState } from "react";

import { describeFollowUp, type FollowUp } from "@shared/survey-summary";
import {
  customScaleLabel,
  reconcileMultiChoiceSelection,
  resolveOptions,
  SATISFACTION_OPTIONS,
  YES_NO_IDS,
  YES_NO_VALUE,
  type AnswerInput,
} from "@shared/survey-rules";
import { isOtherOption, previewComplete, previewVisibleQuestions, tapSubmits, type PreviewAnswers } from "~/lib/preview-state";
import type { EditorSurvey } from "~/lib/surveys.server";

type TFn = (key: string, params?: Record<string, unknown>) => string;

type Question = EditorSurvey["questions"][number];

/**
 * What buyers see, and a way to click through it.
 *
 * The merchant answers it like a buyer would: follow-up questions appear only
 * after the answer that triggers them, one-at-a-time surveys step through with
 * Next and Back, and Submit shows the thank-you message. Nothing is saved or
 * sent. The rules come from `~/lib/preview-state`, which uses the same
 * visibility check as the checkout block.
 *
 * It is drawn with plain HTML controls rather than a copy of the checkout
 * block, so it cannot drift into its own behaviour: it shows the merchant's
 * questions and the shared rules, nothing else. The real survey takes its fonts
 * and colours from the store's checkout, which the caption says.
 */
export function SurveyPreview({ survey, t }: { survey: EditorSurvey; t: TFn }) {
  const questions = survey.questions;
  const oneByOne = survey.layout === "one_by_one";
  const [answers, setAnswers] = useState<PreviewAnswers>({});
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);

  const visible = useMemo(() => previewVisibleQuestions(questions, answers), [questions, answers]);
  const complete = previewComplete(visible, answers);
  const index = Math.min(step, Math.max(visible.length - 1, 0));
  const shown = oneByOne ? visible.slice(index, index + 1) : visible;
  const last = !oneByOne || index >= visible.length - 1;

  const restart = () => {
    setAnswers({});
    setStep(0);
    setDone(false);
  };

  const answer = (question: Question, patch: Partial<AnswerInput>) => {
    const merged: AnswerInput = { ...answers[question.id], ...patch, questionId: question.id };
    setAnswers((previous) => ({ ...previous, [question.id]: merged }));
    const tapped = (patch.optionIds?.length ?? 0) > 0 || typeof patch.numberValue === "number";
    if (tapped && tapSubmits(questions, survey.layout, question, merged)) {
      setDone(true);
    }
  };

  // The same look settings the checkout block applies.
  const gap = survey.design.spacing === "compact" ? "small" : "base";
  const frameClass = survey.design.cardBorder === "no_border" ? "st-preview st-preview--flat" : "st-preview";

  return (
    <s-stack gap="small">
      <div className={frameClass} role="group" aria-label={t("preview.aria")}>
        {done ? (
          <s-stack gap={gap}>
            <s-text type="strong">{survey.thankYouText || t("preview.thanks")}</s-text>
            <s-button type="button" variant="secondary" icon="reset" onClick={restart}>
              {t("preview.restart")}
            </s-button>
          </s-stack>
        ) : (
          <s-stack gap={gap}>
            {survey.design.showTitle && survey.title ? <s-text type="strong">{survey.title}</s-text> : null}
            {survey.intro ? <s-text color="subdued">{survey.intro}</s-text> : null}

            {questions.length === 0 ? <s-text color="subdued">{t("preview.empty")}</s-text> : null}

            {oneByOne && visible.length > 1 && survey.design.showProgress ? (
              <s-text color="subdued" fontSize="small">
                {t("preview.progress", { current: index + 1, total: visible.length })}
              </s-text>
            ) : null}

            {shown.map((question) => {
              const followUp = describeFollowUp(question, questions);
              const number = questions.indexOf(question) + 1;
              return (
                <div key={question.id || number} className={followUp ? "st-preview-q st-preview-follow" : "st-preview-q"}>
                  <s-stack gap="small-200">
                    {followUp ? (
                      <s-text color="subdued" fontSize="small">
                        {followUpText(followUp, t)}
                      </s-text>
                    ) : null}
                    <s-text type="strong">
                      {question.text || t("preview.untitled")}
                      {question.required ? " *" : ""}
                    </s-text>
                    {question.helpText ? (
                      <s-text color="subdued" fontSize="small">
                        {question.helpText}
                      </s-text>
                    ) : null}
                    <Answer
                      question={question}
                      value={answers[question.id]}
                      design={survey.design}
                      label={question.text || t("preview.untitled")}
                      onAnswer={(patch) => answer(question, patch)}
                      t={t}
                    />
                  </s-stack>
                </div>
              );
            })}

            {questions.length > 0 ? (
              <s-stack direction="inline" gap="small">
                {oneByOne && index > 0 ? (
                  <s-button type="button" variant="secondary" onClick={() => setStep(index - 1)}>
                    {t("preview.back")}
                  </s-button>
                ) : null}
                {last ? (
                  <s-button type="button" variant="primary" disabled={!complete} onClick={() => setDone(true)}>
                    {survey.buttonLabel || t("preview.button")}
                  </s-button>
                ) : (
                  <s-button
                    type="button"
                    variant="primary"
                    disabled={!previewComplete(shown, answers)}
                    onClick={() => setStep(index + 1)}
                  >
                    {t("preview.next")}
                  </s-button>
                )}
                {Object.keys(answers).length > 0 ? (
                  <s-button type="button" variant="tertiary" onClick={restart}>
                    {t("preview.restart")}
                  </s-button>
                ) : null}
              </s-stack>
            ) : null}
          </s-stack>
        )}
      </div>
      <s-text color="subdued" fontSize="small">
        {survey.layout === "one_by_one" ? `${t("preview.one_by_one")} ` : ""}
        {t("preview.try_it")} {t("preview.caption")}
      </s-text>
    </s-stack>
  );
}

function followUpText(followUp: FollowUp, t: TFn): string {
  if (followUp.parentNumber === 0) return t("preview.follow_up_unknown");
  const labels = followUp.options.map((o) =>
    o.label ?? (o.id === YES_NO_IDS.yes ? t("surveys.yes") : o.id === YES_NO_IDS.no ? t("surveys.no") : t(`surveys.satisfaction_${o.id}`)),
  );
  if (labels.length > 0) {
    const shown = labels.slice(0, 3).map((l) => `“${l}”`).join(", ");
    const extra = labels.length > 3 ? ` +${labels.length - 3}` : "";
    return t("preview.follow_up_answers", { n: followUp.parentNumber, answers: `${shown}${extra}` });
  }
  if (followUp.min !== null || followUp.max !== null) {
    return t("preview.follow_up_range", { n: followUp.parentNumber, min: followUp.min ?? "…", max: followUp.max ?? "…" });
  }
  return t("preview.follow_up_unknown");
}

function choiceLabel(question: Question, id: string, t: TFn): string {
  if (question.type === "yes_no") return id === YES_NO_IDS.yes ? t("surveys.yes") : t("surveys.no");
  if (question.type === "satisfaction_5") return t(`surveys.satisfaction_${id}`);
  const option = resolveOptions(question).find((o) => o.id === id);
  if (option?.isOther) return t("preview.other_label");
  const label = option?.label ?? id;
  // F4: an answer only some buyers see says where, so the merchant is not
  // surprised it is missing for buyers elsewhere.
  const countries = option?.countries ?? [];
  if (countries.length === 0) return label;
  const shown = countries.slice(0, 3).join(", ");
  return `${label} (${countries.length > 3 ? `${shown} +${countries.length - 3}` : shown})`;
}

/** The ids and numeric values a buyer picks from, for one-pick questions. */
function pickOptions(question: Question): { id: string; value?: number }[] {
  if (question.type === "yes_no") {
    return [
      { id: YES_NO_IDS.yes, value: YES_NO_VALUE.yes },
      { id: YES_NO_IDS.no, value: YES_NO_VALUE.no },
    ];
  }
  if (question.type === "satisfaction_5") return SATISFACTION_OPTIONS.map((o) => ({ id: o.id, value: o.value }));
  return resolveOptions(question).map((o) => ({ id: o.id }));
}

function Answer({
  question,
  value,
  design,
  label,
  onAnswer,
  t,
}: {
  question: Question;
  value: AnswerInput | undefined;
  design: EditorSurvey["design"];
  label: string;
  onAnswer: (patch: Partial<AnswerInput>) => void;
  t: TFn;
}) {
  const selected = value?.optionIds ?? [];
  const otherChosen = selected.some((id) => isOtherOption(question, id));
  const otherField = otherChosen ? (
    <input
      className="st-preview-input"
      type="text"
      aria-label={t("preview.other_label")}
      placeholder={t("preview.other_placeholder")}
      value={value?.otherText ?? ""}
      onChange={(event) => onAnswer({ otherText: event.currentTarget.value })}
    />
  ) : null;

  switch (question.type) {
    case "single_choice":
    case "yes_no":
    case "satisfaction_5":
      return (
        <s-stack gap="small-200">
          <div className="st-preview-options" role="radiogroup" aria-label={label}>
            {pickOptions(question).map((option) => {
              const on = selected.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? "st-preview-choice st-preview-choice--on" : "st-preview-choice"}
                  onClick={() =>
                    onAnswer(option.value === undefined ? { optionIds: [option.id] } : { optionIds: [option.id], numberValue: option.value })
                  }
                >
                  <span className="st-dot" aria-hidden="true" />
                  {choiceLabel(question, option.id, t)}
                </button>
              );
            })}
          </div>
          {otherField}
        </s-stack>
      );
    case "multi_choice": {
      const options = resolveOptions(question);
      const exclusive = options.filter((o) => o.exclusive).map((o) => o.id);
      return (
        <s-stack gap="small-200">
          <div className="st-preview-options" role="group" aria-label={label}>
            {options.map((option) => {
              const on = selected.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={on ? "st-preview-choice st-preview-choice--on" : "st-preview-choice"}
                  onClick={() => {
                    const next = on ? selected.filter((id) => id !== option.id) : [...selected, option.id];
                    onAnswer({ optionIds: reconcileMultiChoiceSelection(exclusive, selected, next) });
                  }}
                >
                  <span className="st-box" aria-hidden="true" />
                  {choiceLabel(question, option.id, t)}
                </button>
              );
            })}
          </div>
          {otherField}
        </s-stack>
      );
    }
    case "dropdown":
      return (
        <s-stack gap="small-200">
          <select
            className="st-preview-input"
            aria-label={label}
            value={selected[0] ?? ""}
            onChange={(event) => onAnswer({ optionIds: event.currentTarget.value ? [event.currentTarget.value] : [] })}
          >
            <option value="">{t("preview.dropdown")}</option>
            {resolveOptions(question).map((option) => (
              <option key={option.id} value={option.id}>
                {choiceLabel(question, option.id, t)}
              </option>
            ))}
          </select>
          {otherField}
        </s-stack>
      );
    case "rating_5":
      return (
        <Scale
          values={[1, 2, 3, 4, 5]}
          value={value?.numberValue ?? null}
          stars={design.ratingStyle === "stars"}
          low={customScaleLabel(design.scaleLowLabel) ?? t("preview.rating_low")}
          high={customScaleLabel(design.scaleHighLabel) ?? t("preview.rating_high")}
          label={label}
          onPick={(n) => onAnswer({ numberValue: n })}
        />
      );
    case "nps":
      return (
        <Scale
          values={Array.from({ length: 11 }, (_, n) => n)}
          value={value?.numberValue ?? null}
          low={customScaleLabel(design.scaleLowLabel) ?? t("surveys.nps_low")}
          high={customScaleLabel(design.scaleHighLabel) ?? t("surveys.nps_high")}
          label={label}
          onPick={(n) => onAnswer({ numberValue: n })}
        />
      );
    default:
      return question.textMultiline ? (
        <textarea
          className="st-preview-input st-preview-area"
          aria-label={label}
          placeholder={question.placeholder ?? ""}
          value={value?.textValue ?? ""}
          onChange={(event) => onAnswer({ textValue: event.currentTarget.value })}
        />
      ) : (
        <input
          className="st-preview-input"
          type="text"
          aria-label={label}
          placeholder={question.placeholder ?? ""}
          value={value?.textValue ?? ""}
          onChange={(event) => onAnswer({ textValue: event.currentTarget.value })}
        />
      );
  }
}

function Scale({
  values,
  value,
  stars = false,
  low,
  high,
  label,
  onPick,
}: {
  values: number[];
  value: number | null;
  stars?: boolean;
  low?: string;
  high?: string;
  label: string;
  onPick: (n: number) => void;
}) {
  return (
    <s-stack gap="small-200">
      <div className="st-preview-scale" role="radiogroup" aria-label={label}>
        {values.map((n) => {
          // Stars fill up to the chosen one, like the checkout block.
          const on = value !== null && (stars ? n <= value : n === value);
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={String(n)}
              className={on ? "st-preview-scale-btn st-preview-scale-btn--on" : "st-preview-scale-btn"}
              onClick={() => onPick(n)}
            >
              {stars ? "★" : n}
            </button>
          );
        })}
      </div>
      {low || high ? (
        <s-grid gridTemplateColumns="minmax(0, 1fr) minmax(0, 1fr)" gap="small">
          <s-text color="subdued" fontSize="small">
            {low ?? ""}
          </s-text>
          <s-text color="subdued" fontSize="small">
            <span className="st-align-end">{high ?? ""}</span>
          </s-text>
        </s-grid>
      ) : null}
    </s-stack>
  );
}
