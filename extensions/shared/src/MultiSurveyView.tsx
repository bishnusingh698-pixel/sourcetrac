/** @jsxImportSource preact */
import { OTHER_CHANNEL, applyExclusiveToggle, type CompiledQuestion } from "./survey-logic";
import { optionsFor, type AnswerState } from "./use-multi-survey";

/**
 * The multi-question survey, shared by both surfaces.
 *
 * Written with Polaris web components (`s-stack`, `s-clickable`, ...), which the
 * 2025-10+ extension runtime provides on both the Thank-you and the Order-status
 * page, so one view serves both without injected primitives.
 *
 * Per question type it renders the matching control: choice tiles, a dropdown,
 * Yes / No, a 1–5 rating, five satisfaction levels, 0–10 NPS, or a text field.
 * Nothing here submits; the hook decides when the set is complete.
 */

export interface MultiSurveyViewProps {
  phase: "loading" | "asking" | "sending" | "done" | "hidden";
  title: string;
  intro: string | null;
  buttonLabel: string;
  thankYouText: string;
  questions: CompiledQuestion[];
  answers: AnswerState;
  oneByOne: boolean;
  step: number;
  total: number;
  complete: boolean;
  /** One at a time: whether the current question allows Next. */
  canAdvance?: boolean;
  onAnswer: (questionId: string, patch: Partial<import("./survey-logic").AnswerInput>) => void;
  onNext: () => void;
  onBack: () => void;
  onSubmit: () => void;
  busy: boolean;
  t: (key: string, fallback: string) => string;
}

/** `currentTarget.value` of a field event, without trusting its shape. */
function fieldValue(event: { currentTarget: unknown }): string {
  const value = (event.currentTarget as { value?: unknown } | null)?.value;
  return typeof value === "string" ? value : "";
}

function fieldValues(event: { currentTarget: unknown }): string[] {
  const value = (event.currentTarget as { values?: unknown } | null)?.values;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function MultiSurveyView(props: MultiSurveyViewProps) {
  const {
    phase,
    title,
    intro,
    buttonLabel,
    thankYouText,
    questions,
    answers,
    oneByOne,
    step,
    total,
    complete,
    canAdvance = true,
    onAnswer,
    onNext,
    onBack,
    onSubmit,
    busy,
    t,
  } = props;

  if (phase === "hidden") return null;

  if (phase === "loading") {
    return (
      <s-text color="subdued" type="small">
        {t("sourcetrac.loading", "Loading…")}
      </s-text>
    );
  }

  if (phase === "done") {
    return <s-text tone="success">{thankYouText || t("sourcetrac.thanks", "Thanks!")}</s-text>;
  }

  return (
    <s-stack gap="base">
      {title ? <s-heading>{title}</s-heading> : null}
      {intro ? (
        <s-text color="subdued" type="small">
          {intro}
        </s-text>
      ) : null}

      {oneByOne && total > 1 ? (
        <s-text color="subdued" type="small">
          {t("sourcetrac.progress", "{{current}} of {{total}}")
            .replace("{{current}}", String(Math.min(step + 1, total)))
            .replace("{{total}}", String(total))}
        </s-text>
      ) : null}

      {questions.map((question) => (
        <QuestionField key={question.id} question={question} answer={answers[question.id]} onAnswer={onAnswer} t={t} />
      ))}

      <s-stack direction="inline" gap="small">
        {oneByOne && step > 0 ? (
          <s-button onClick={onBack} disabled={busy}>
            {t("sourcetrac.back", "Back")}
          </s-button>
        ) : null}
        {oneByOne && step < total - 1 ? (
          <s-button variant="primary" onClick={onNext} disabled={busy || !canAdvance}>
            {t("sourcetrac.next", "Next")}
          </s-button>
        ) : (
          <s-button variant="primary" onClick={onSubmit} disabled={busy || !complete} loading={busy}>
            {buttonLabel || t("sourcetrac.submit", "Submit")}
          </s-button>
        )}
      </s-stack>
    </s-stack>
  );
}

function QuestionField({
  question,
  answer,
  onAnswer,
  t,
}: {
  question: CompiledQuestion;
  answer: import("./survey-logic").AnswerInput | undefined;
  onAnswer: (questionId: string, patch: Partial<import("./survey-logic").AnswerInput>) => void;
  t: (key: string, fallback: string) => string;
}) {
  const set = (patch: Partial<import("./survey-logic").AnswerInput>) => onAnswer(question.id, patch);
  const otherLabel = t("sourcetrac.other", "Other");
  const options = optionsFor(question, otherLabel);
  const isOtherSelected =
    answer?.optionIds?.some((id) => options.find((o) => o.id === id)?.isOther || id === OTHER_CHANNEL) ?? false;

  return (
    <s-stack gap="small-200">
      <s-text type="strong">
        {question.text}
        {question.required ? " *" : ""}
      </s-text>
      {question.helpText ? (
        <s-text color="subdued" type="small">
          {question.helpText}
        </s-text>
      ) : null}

      {(question.type === "single_choice" || question.type === "dropdown") && (
        <s-stack gap="small-200">
          {options.map((option) => {
            const isSelected = answer?.optionIds?.[0] === option.id;
            return (
              <s-clickable
                key={option.id}
                disabled={false}
                onClick={() =>
                  set({
                    optionIds: [option.id],
                    numberValue: null,
                    // Text typed into "Other" belongs to "Other" only.
                    otherText: option.isOther || option.id === OTHER_CHANNEL ? (answer?.otherText ?? null) : null,
                  })
                }
                accessibilityLabel={option.label}
                border="base"
                borderRadius="base"
                background={isSelected ? "subdued" : "transparent"}
                padding="base"
              >
                <s-text type={isSelected ? "strong" : "generic"}>{option.label}</s-text>
              </s-clickable>
            );
          })}
        </s-stack>
      )}

      {question.type === "multi_choice" && (
        <s-choice-list
          name={question.id}
          values={answer?.optionIds ?? []}
          multiple
          onChange={(event) => {
            const optionIds = applyExclusiveToggle(
              options.filter((option) => option.exclusive).map((option) => option.id),
              answer?.optionIds ?? [],
              fieldValues(event),
            );
            const keepsOther = optionIds.some(
              (id) => id === OTHER_CHANNEL || options.find((o) => o.id === id)?.isOther,
            );
            set({ optionIds, numberValue: null, otherText: keepsOther ? (answer?.otherText ?? null) : null });
          }}
        >
          {options.map((option) => (
            <s-choice key={option.id} value={option.id}>
              {option.label}
            </s-choice>
          ))}
        </s-choice-list>
      )}

      {question.type === "yes_no" && (
        <s-choice-list
          name={question.id}
          values={answer?.optionIds ?? []}
          onChange={(event) => {
            const id = fieldValues(event)[0];
            set({ optionIds: id ? [id] : [], numberValue: id === "yes" ? 1 : id === "no" ? 0 : null });
          }}
        >
          <s-choice value="yes">{t("sourcetrac.yes", "Yes")}</s-choice>
          <s-choice value="no">{t("sourcetrac.no", "No")}</s-choice>
        </s-choice-list>
      )}

      {question.type === "rating_5" && (
        <s-stack direction="inline" gap="small-200">
          {[1, 2, 3, 4, 5].map((n) => (
            <s-button
              key={n}
              variant={answer?.numberValue === n ? "primary" : "secondary"}
              onClick={() => set({ numberValue: n, optionIds: [] })}
              accessibilityLabel={String(n)}
            >
              {String(n)}
            </s-button>
          ))}
        </s-stack>
      )}

      {question.type === "satisfaction_5" && (
        <s-stack gap="small-200">
          {[
            "very_dissatisfied",
            "dissatisfied",
            "neutral",
            "satisfied",
            "very_satisfied",
          ].map((id) => {
            const isSelected = answer?.optionIds?.[0] === id;
            const label = t(`sourcetrac.satisfaction_${id}`, id);
            return (
              <s-clickable
                key={id}
                onClick={() => set({ optionIds: [id], numberValue: null })}
                accessibilityLabel={label}
                border="base"
                borderRadius="base"
                background={isSelected ? "subdued" : "transparent"}
                padding="base"
              >
                <s-text type={isSelected ? "strong" : "generic"}>{label}</s-text>
              </s-clickable>
            );
          })}
        </s-stack>
      )}

      {question.type === "nps" && (
        <s-stack direction="inline" gap="small-200">
          {Array.from({ length: 11 }, (_, n) => (
            <s-button
              key={n}
              variant={answer?.numberValue === n ? "primary" : "secondary"}
              onClick={() => set({ numberValue: n, optionIds: [] })}
              accessibilityLabel={String(n)}
            >
              {String(n)}
            </s-button>
          ))}
        </s-stack>
      )}

      {question.type === "text" &&
        (question.textMultiline ? (
          <s-text-area
            label={question.text}
            defaultValue={answer?.textValue ?? ""}
            placeholder={question.placeholder ?? undefined}
            maxLength={500}
            onInput={(event) => set({ textValue: fieldValue(event) })}
            onChange={(event) => set({ textValue: fieldValue(event) })}
          />
        ) : (
          <s-text-field
            label={question.text}
            defaultValue={answer?.textValue ?? ""}
            placeholder={question.placeholder ?? undefined}
            maxLength={500}
            onInput={(event) => set({ textValue: fieldValue(event) })}
            onChange={(event) => set({ textValue: fieldValue(event) })}
          />
        ))}

      {isOtherSelected ? (
        <s-text-field
          label={t("sourcetrac.otherLabel", "Tell us more")}
          defaultValue={answer?.otherText ?? ""}
          onInput={(event) => set({ otherText: fieldValue(event) })}
          onChange={(event) => set({ otherText: fieldValue(event) })}
          maxLength={500}
        />
      ) : null}
    </s-stack>
  );
}

/**
 * What the block shows inside the checkout editor.
 *
 * The editor has no real order, so the live survey has nothing to attribute an
 * answer to and rendered nothing at all: a merchant who added the block saw it
 * appear empty and reasonably concluded it was broken. This shows sample answers
 * instead, with nothing wired to submit, so a click in the editor never writes a
 * response against a placeholder order.
 */
export function MultiSurveyPreview({ t }: { t: (key: string, fallback: string) => string }) {
  const sample: CompiledQuestion = {
    id: "preview-q1",
    type: "single_choice",
    text: t("sourcetrac.previewQuestion", "How did you hear about us?"),
    textMultiline: false,
    required: true,
    randomizeOptions: false,
    allowOther: true,
    options: [
      { id: "instagram", label: "Instagram", isOther: false },
      { id: "google", label: t("sourcetrac.previewGoogle", "Google search"), isOther: false },
      { id: "friend-or-family", label: t("sourcetrac.previewFriend", "Friend or family"), isOther: false },
    ],
  };

  return (
    <s-stack gap="small-200">
      <MultiSurveyView
        phase="asking"
        title={t("sourcetrac.previewTitle", "Quick question")}
        intro={null}
        buttonLabel={t("sourcetrac.submit", "Submit")}
        thankYouText={t("sourcetrac.thanks", "Thanks!")}
        questions={[sample]}
        answers={{}}
        oneByOne={false}
        step={0}
        total={1}
        complete
        onAnswer={() => undefined}
        onNext={() => undefined}
        onBack={() => undefined}
        onSubmit={() => undefined}
        busy={false}
        t={t}
      />
      <s-text color="subdued" type="small">
        {t(
          "sourcetrac.previewNote",
          "Preview. Buyers see the questions and answers you set in the SourceTrac app.",
        )}
      </s-text>
    </s-stack>
  );
}
