import { useState } from "react";

import { AdvancedDisclosure, Banner } from "~/components/admin-ui";
import { LogicMap } from "~/components/logic-map";
import {
  LIMITS,
  fixedOptions,
  isChoiceType,
  isNumericType,
  questionHasMerchantOptions,
  type QuestionType,
  type SurveyQuestionDef,
} from "@shared/survey-rules";
import type { EditorSurvey } from "~/lib/surveys.server";

/**
 * The Studio's left panel: the question editor, the design controls and the
 * Logic map, behind a segmented control.
 *
 * Extracted from the old single-page editor so the Studio (S1) and any other
 * surface share one implementation. All text is passed in translated; the
 * component never formats a number or a date itself.
 */

/**
 * The admin translator. The branded i18next type, not a plain function, so `t`
 * can be handed straight to the shared Logic map and preview.
 */
export type TFn = import("~/lib/i18n").TFunction;

const QUESTION_TYPE_KEYS: Record<QuestionType, string> = {
  single_choice: "surveys.type_single",
  multi_choice: "surveys.type_multi",
  dropdown: "surveys.type_dropdown",
  yes_no: "surveys.type_yesno",
  rating_5: "surveys.type_rating",
  satisfaction_5: "surveys.type_satisfaction",
  nps: "surveys.type_nps",
  text: "surveys.type_text",
};

/** DOM id for a validator path, e.g. `questions[0].text` -> `err-questions-0-text`. */
export function errorId(path: string): string {
  return `err-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export function fieldValue(event: Event): string {
  const target = event.currentTarget as { value?: unknown };
  return typeof target.value === "string" ? target.value : "";
}

export function checkboxChecked(event: Event): boolean {
  const target = event.currentTarget as { checked?: unknown };
  return target.checked === true;
}

function numberOrNull(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The options a show-if rule can reference: the merchant's own options, or the
 * fixed Yes / No and satisfaction options the shared rules recognise.
 */
function showIfOptions(
  question: SurveyQuestionDef | undefined,
): Array<{ id: string; label: string; isOther?: boolean }> {
  if (!question) return [];
  if (questionHasMerchantOptions(question.type)) {
    return (question.options ?? []).map((o) => ({ id: o.id, label: o.label, isOther: o.isOther }));
  }
  return fixedOptions(question).map((o) => ({ id: o.id, label: o.label }));
}

export function TextField({
  label,
  value,
  maxLength,
  onInput,
  placeholder,
  multiline,
  error,
  errorPath,
}: {
  label: string;
  value: string;
  maxLength?: number;
  onInput: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  error?: string;
  errorPath?: string;
}) {
  const id = errorPath ? errorId(errorPath) : undefined;
  if (multiline) {
    return (
      <s-text-area
        id={id}
        label={label}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        error={error}
        onInput={(e: Event) => onInput(fieldValue(e))}
      />
    );
  }
  return (
    <s-text-field
      id={id}
      label={label}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      error={error}
      onInput={(e: Event) => onInput(fieldValue(e))}
    />
  );
}

function NumberField({
  label,
  value,
  onInput,
}: {
  label: string;
  value: number | null;
  onInput: (value: number | null) => void;
}) {
  return (
    <s-number-field
      label={label}
      value={value != null ? String(value) : ""}
      onInput={(e: Event) => onInput(numberOrNull(fieldValue(e)))}
    />
  );
}

/**
 * The whole left panel: a segmented control over Questions, Design and Logic map.
 *
 * `activeQuestionId` is driven by the preview's click-to-edit (S6): the preview
 * selects a question here and the card is scrolled into view.
 */
export function SurveyEditor({
  draft,
  update,
  t,
  errors,
  view,
  setView,
  activeQuestionId,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  errors: Map<string, string>;
  view: "questions" | "design" | "logic";
  setView: (view: "questions" | "design" | "logic") => void;
  activeQuestionId?: string | null;
}) {
  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button variant={view === "questions" ? "primary" : "secondary"} onClick={() => setView("questions")}>
          {t("studio.tab_questions")}
        </s-button>
        <s-button variant={view === "design" ? "primary" : "secondary"} onClick={() => setView("design")}>
          {t("studio.tab_design")}
        </s-button>
        <s-button variant={view === "logic" ? "primary" : "secondary"} onClick={() => setView("logic")}>
          {t("studio.tab_logic")}
        </s-button>
      </s-stack>

      {view === "questions" ? (
        <QuestionList
          draft={draft}
          update={update}
          t={t}
          limits={LIMITS}
          errors={errors}
          activeQuestionId={activeQuestionId}
        />
      ) : null}

      {view === "design" ? <DesignPanel draft={draft} update={update} t={t} /> : null}

      {view === "logic" ? (
        <s-section heading={t("studio.tab_logic")} subheading={t("logic.section_help")} padding="none">
          <LogicMap
            draft={draft}
            update={update}
            t={t}
            maxQuestions={LIMITS.MAX_QUESTIONS}
            canUseLogic
            onEditQuestion={(questionId) => {
              setView("questions");
              requestAnimationFrame(() => {
                document.getElementById(`q-${questionId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
              });
            }}
          />
        </s-section>
      ) : null}
    </s-stack>
  );
}

function QuestionList({
  draft,
  update,
  t,
  limits,
  errors,
  activeQuestionId,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
  activeQuestionId?: string | null;
}) {
  const questions = draft.questions;

  const setQuestion = (index: number, patch: Partial<EditorSurvey["questions"][number]>) => {
    const next = questions.map((q, i) => (i === index ? { ...q, ...patch } : q));
    update({ questions: next });
  };

  const moveQuestion = (index: number, to: number) => {
    if (to < 0 || to >= questions.length) return;
    const next = [...questions];
    const [item] = next.splice(index, 1);
    if (item) next.splice(to, 0, item);
    update({ questions: next });
  };

  const addQuestion = () => {
    if (questions.length >= limits.MAX_QUESTIONS) return;
    update({
      questions: [
        ...questions,
        {
          id: "",
          type: "single_choice",
          text: "",
          required: false,
          allowOther: false,
          options: [
            { id: "", label: "Answer 1", isOther: false, exclusive: false, archived: false, translations: {} },
            { id: "", label: "Answer 2", isOther: false, exclusive: false, archived: false, translations: {} },
          ],
        },
      ],
    });
  };

  const removeQuestion = (index: number) => update({ questions: questions.filter((_, i) => i !== index) });

  const duplicateQuestion = (index: number) => {
    if (questions.length >= limits.MAX_QUESTIONS) return;
    const source = questions[index];
    if (!source) return;
    const copy: EditorSurvey["questions"][number] = {
      ...source,
      id: "",
      options: source.options.map((o) => ({ ...o, id: "" })),
    };
    const next = [...questions];
    next.splice(index + 1, 0, copy);
    update({ questions: next });
  };

  return (
    <s-stack gap="base">
      {questions.length > limits.RECOMMENDED_MAX_QUESTIONS ? (
        <s-banner tone="warning">{t("surveys.too_many_soft")}</s-banner>
      ) : null}

      {questions.map((question, index) => (
        <s-box
          key={question.id || `new-${index}`}
          id={`q-${question.id || `new-${index}`}`}
          padding="small"
          border="base"
          borderRadius="base"
          background={question.id && question.id === activeQuestionId ? "strong" : undefined}
        >
          <s-stack gap="base">
            <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
              <s-text type="strong">{t("surveys.question_number", { n: index + 1, total: questions.length })}</s-text>
              <s-stack direction="inline" gap="small">
                <s-button type="button" onClick={() => moveQuestion(index, index - 1)} disabled={index === 0 || undefined}>
                  ↑
                </s-button>
                <s-button
                  type="button"
                  onClick={() => moveQuestion(index, index + 1)}
                  disabled={index === questions.length - 1 || undefined}
                >
                  ↓
                </s-button>
                <s-button type="button" onClick={() => duplicateQuestion(index)}>
                  {t("surveys.duplicate_question")}
                </s-button>
                <s-button type="button" tone="critical" onClick={() => removeQuestion(index)}>
                  {t("surveys.remove_question")}
                </s-button>
              </s-stack>
            </s-stack>

            <s-select
              label={t("surveys.field_type")}
              value={question.type}
              onChange={(e: Event) => setQuestion(index, { type: fieldValue(e) as QuestionType })}
            >
              {(Object.keys(QUESTION_TYPE_KEYS) as QuestionType[]).map((type) => (
                <s-option key={type} value={type}>
                  {t(QUESTION_TYPE_KEYS[type])}
                </s-option>
              ))}
            </s-select>

            <TextField
              label={t("surveys.field_question")}
              value={question.text}
              maxLength={limits.MAX_QUESTION_TEXT}
              error={errors.get(`questions[${index}].text`)}
              errorPath={`questions[${index}].text`}
              onInput={(v) => setQuestion(index, { text: v })}
            />
            <TextField
              label={t("surveys.field_help")}
              value={question.helpText ?? ""}
              maxLength={limits.MAX_HELP_TEXT}
              onInput={(v) => setQuestion(index, { helpText: v || null })}
            />

            <s-switch
              label={t("surveys.field_required")}
              checked={question.required || undefined}
              onChange={(e: Event) => setQuestion(index, { required: checkboxChecked(e) })}
            />

            {questionHasMerchantOptions(question.type) ? (
              <OptionEditor question={question} index={index} setQuestion={setQuestion} t={t} limits={limits} errors={errors} />
            ) : null}

            {question.type === "multi_choice" ? (
              <s-stack direction="inline" gap="small">
                <NumberField
                  label={t("surveys.field_min_selections")}
                  value={question.minSelections ?? null}
                  onInput={(v) => setQuestion(index, { minSelections: v })}
                />
                <NumberField
                  label={t("surveys.field_max_selections")}
                  value={question.maxSelections ?? null}
                  onInput={(v) => setQuestion(index, { maxSelections: v })}
                />
              </s-stack>
            ) : null}

            {question.type === "text" ? (
              <s-stack gap="small">
                <s-switch
                  label={t("surveys.field_multiline")}
                  checked={question.textMultiline || undefined}
                  onChange={(e: Event) => setQuestion(index, { textMultiline: checkboxChecked(e) })}
                />
                <TextField
                  label={t("surveys.field_placeholder")}
                  value={question.placeholder ?? ""}
                  maxLength={limits.MAX_HELP_TEXT}
                  onInput={(v) => setQuestion(index, { placeholder: v || null })}
                />
              </s-stack>
            ) : null}

            <ShowIfEditor question={question} index={index} questions={questions} setQuestion={setQuestion} t={t} />
          </s-stack>
        </s-box>
      ))}

      <s-button type="button" onClick={addQuestion} disabled={questions.length >= limits.MAX_QUESTIONS || undefined}>
        {t("surveys.add_question")}
      </s-button>
    </s-stack>
  );
}

function OptionEditor({
  question,
  index,
  setQuestion,
  t,
  limits,
  errors,
}: {
  question: EditorSurvey["questions"][number];
  index: number;
  setQuestion: (index: number, patch: Partial<EditorSurvey["questions"][number]>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
}) {
  const options = question.options.filter((o) => !o.isOther);
  const count = options.length;

  const setOptions = (next: EditorSurvey["questions"][number]["options"]) => setQuestion(index, { options: next });

  const move = (from: number, to: number) => {
    if (to < 0 || to >= options.length) return;
    const next = [...options];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    setOptions([...next, ...question.options.filter((o) => o.isOther)]);
  };

  const optionsError = errors.get(`questions[${index}].options`);

  return (
    <s-stack gap="small">
      <s-text color="subdued" fontSize="small">
        {t("surveys.option_counter", { count, max: limits.MAX_OPTIONS })}
      </s-text>
      {optionsError ? (
        <s-banner tone="critical" id={errorId(`questions[${index}].options`)}>
          {optionsError}
        </s-banner>
      ) : null}
      {options.map((option, i) => (
        <s-stack key={option.id || `new-${i}`} gap="small-200">
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              id={errorId(`questions[${index}].options[${i}].label`)}
              label={t("surveys.field_option", { n: i + 1 })}
              value={option.label}
              maxLength={limits.MAX_OPTION_LABEL}
              error={errors.get(`questions[${index}].options[${i}].label`)}
              onInput={(e: Event) => {
                const next = options.map((o, j) => (j === i ? { ...o, label: fieldValue(e) } : o));
                setOptions([...next, ...question.options.filter((o) => o.isOther)]);
              }}
            />
            <s-button type="button" onClick={() => move(i, i - 1)} disabled={i === 0 || undefined}>
              ↑
            </s-button>
            <s-button type="button" onClick={() => move(i, i + 1)} disabled={i === options.length - 1 || undefined}>
              ↓
            </s-button>
            <s-button
              type="button"
              tone="critical"
              onClick={() => setOptions([...options.filter((_, j) => j !== i), ...question.options.filter((o) => o.isOther)])}
              disabled={count <= limits.MIN_OPTIONS || undefined}
            >
              {t("settings.remove_option", { label: option.label })}
            </s-button>
          </s-stack>
          {question.type === "multi_choice" ? (
            <s-checkbox
              name={`exclusive-${index}-${i}`}
              label={t("studio.exclusive_option")}
              checked={option.exclusive || undefined}
              onChange={(e: Event) => {
                const checked = checkboxChecked(e);
                // Max one exclusive option per question: turning this on clears
                // the flag on every other option.
                const next = options.map((o, j) =>
                  j === i ? { ...o, exclusive: checked } : checked ? { ...o, exclusive: false } : o,
                );
                setOptions([...next, ...question.options.filter((o) => o.isOther)]);
              }}
            />
          ) : null}
        </s-stack>
      ))}

      <s-stack direction="inline" gap="small">
        <s-button
          type="button"
          onClick={() =>
            setOptions([
              ...options,
              { id: "", label: t("surveys.new_option_label", { n: count + 1 }), isOther: false, exclusive: false, archived: false, translations: {} },
              ...question.options.filter((o) => o.isOther),
            ])
          }
          disabled={count >= limits.MAX_OPTIONS || undefined}
        >
          {t("surveys.add_option")}
        </s-button>
      </s-stack>

      {question.type === "multi_choice" ? (
        <s-text color="subdued" fontSize="small">
          {t("studio.exclusive_option_help")}
        </s-text>
      ) : null}

      <s-switch
        label={t("surveys.field_allow_other")}
        checked={question.allowOther || undefined}
        onChange={(e: Event) => setQuestion(index, { allowOther: checkboxChecked(e) })}
      />
      <s-switch
        label={t("surveys.field_randomize")}
        checked={question.randomizeOptions || undefined}
        onChange={(e: Event) => setQuestion(index, { randomizeOptions: checkboxChecked(e) })}
      />
    </s-stack>
  );
}

function ShowIfEditor({
  question,
  index,
  questions,
  setQuestion,
  t,
}: {
  question: EditorSurvey["questions"][number];
  index: number;
  questions: EditorSurvey["questions"];
  setQuestion: (index: number, patch: Partial<EditorSurvey["questions"][number]>) => void;
  t: TFn;
}) {
  const earlier = questions.slice(0, index);
  const referenceable = earlier.filter((q) => isChoiceType(q.type) || isNumericType(q.type));
  const condition = question.showIf;
  const conditionQuestion = condition?.questionId ? questions.find((q) => q.id === condition.questionId) : undefined;

  if (referenceable.length === 0) return null;

  return (
    <s-stack gap="small">
      <s-select
        label={t("surveys.show_if_label")}
        value={condition?.questionId ?? ""}
        onChange={(e: Event) => {
          const value = fieldValue(e);
          setQuestion(index, { showIf: value ? { questionId: value, optionIds: [] } : null });
        }}
      >
        <s-option value="">{t("surveys.show_if_always")}</s-option>
        {referenceable.map((q, qi) => (
          <s-option key={q.id || `e-${qi}`} value={q.id || `e-${qi}`}>
            {q.text || t("surveys.question_number", { n: questions.indexOf(q) + 1, total: questions.length })}
          </s-option>
        ))}
      </s-select>

      {condition?.questionId ? (
        <s-stack gap="small">
          {isChoiceType(conditionQuestion?.type ?? "single_choice") && !isNumericType(conditionQuestion?.type ?? "single_choice") ? (
            showIfOptions(conditionQuestion)
              .filter((o) => !o.isOther)
              .map((option, oi) => (
                <s-checkbox
                  key={option.id || `c-${oi}`}
                  label={option.label}
                  checked={(condition.optionIds ?? []).includes(option.id) || undefined}
                  onChange={(e: Event) => {
                    const ids = new Set(condition.optionIds ?? []);
                    if (checkboxChecked(e)) ids.add(option.id);
                    else ids.delete(option.id);
                    setQuestion(index, { showIf: { ...condition, optionIds: [...ids] } });
                  }}
                />
              ))
          ) : (
            <s-stack direction="inline" gap="small">
              <NumberField
                label={t("surveys.show_if_min")}
                value={condition.min ?? null}
                onInput={(v) => setQuestion(index, { showIf: { ...condition, min: v ?? undefined } })}
              />
              <NumberField
                label={t("surveys.show_if_max")}
                value={condition.max ?? null}
                onInput={(v) => setQuestion(index, { showIf: { ...condition, max: v ?? undefined } })}
              />
            </s-stack>
          )}
        </s-stack>
      ) : null}
    </s-stack>
  );
}

/** S11 + S12: only the options the checkout components can really support. */
export function DesignPanel({
  draft,
  update,
  t,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
}) {
  const design = draft.design;
  const set = (patch: Partial<typeof design>) => update({ design: { ...design, ...patch } });

  return (
    <s-stack gap="base">
      <s-section heading={t("studio.tab_design")} subheading={t("studio.design_help")} padding="none">
        <s-stack gap="base">
          <s-select
            label={t("studio.design_layout")}
            value={design.layout}
            onChange={(e: Event) => set({ layout: fieldValue(e) as "all" | "one_by_one" })}
          >
            <s-option value="all">{t("surveys.layout_all")}</s-option>
            <s-option value="one_by_one">{t("surveys.layout_one")}</s-option>
          </s-select>

          <s-switch
            label={t("studio.design_progress")}
            checked={design.showProgress || undefined}
            disabled={design.layout !== "one_by_one" || undefined}
            onChange={(e: Event) => set({ showProgress: checkboxChecked(e) })}
          />

          <s-switch
            label={t("studio.design_show_title")}
            checked={design.showTitle || undefined}
            onChange={(e: Event) => set({ showTitle: checkboxChecked(e) })}
          />

          <s-select
            label={t("studio.design_rating_style")}
            value={design.ratingStyle}
            onChange={(e: Event) => set({ ratingStyle: fieldValue(e) as "numbers" | "stars" })}
          >
            <s-option value="numbers">{t("studio.design_rating_numbers")}</s-option>
            <s-option value="stars">{t("studio.design_rating_stars")}</s-option>
          </s-select>

          <TextField
            label={t("studio.design_scale_low")}
            value={design.scaleLowLabel}
            maxLength={LIMITS.MAX_SCALE_LABEL}
            onInput={(v) => set({ scaleLowLabel: v })}
          />
          <TextField
            label={t("studio.design_scale_high")}
            value={design.scaleHighLabel}
            maxLength={LIMITS.MAX_SCALE_LABEL}
            onInput={(v) => set({ scaleHighLabel: v })}
          />

          <s-select
            label={t("studio.design_card")}
            value={design.cardBorder}
            onChange={(e: Event) => set({ cardBorder: fieldValue(e) as "border" | "no_border" })}
          >
            <s-option value="border">{t("studio.design_card_border")}</s-option>
            <s-option value="no_border">{t("studio.design_card_none")}</s-option>
          </s-select>

          <s-select
            label={t("studio.design_spacing")}
            value={design.spacing}
            onChange={(e: Event) => set({ spacing: fieldValue(e) as "compact" | "comfortable" })}
          >
            <s-option value="comfortable">{t("studio.design_spacing_comfortable")}</s-option>
            <s-option value="compact">{t("studio.design_spacing_compact")}</s-option>
          </s-select>

          <AdvancedDisclosure label={t("studio.design_advanced")}>
            <s-stack gap="base">
              <TextField
                label={t("surveys.field_title")}
                value={draft.title}
                maxLength={LIMITS.MAX_SURVEY_TITLE}
                onInput={(v) => update({ title: v })}
              />
              <TextField
                label={t("surveys.field_intro")}
                value={draft.intro ?? ""}
                maxLength={LIMITS.MAX_INTRO_TEXT}
                onInput={(v) => update({ intro: v || null })}
              />
              <TextField
                label={t("surveys.field_button")}
                value={draft.buttonLabel}
                maxLength={LIMITS.MAX_BUTTON_LABEL}
                onInput={(v) => update({ buttonLabel: v })}
              />
              <TextField
                label={t("surveys.field_thank_you")}
                value={draft.thankYouText}
                maxLength={LIMITS.MAX_THANK_YOU_TEXT}
                onInput={(v) => update({ thankYouText: v })}
              />
            </s-stack>
          </AdvancedDisclosure>
        </s-stack>
      </s-section>
    </s-stack>
  );
}

export { Banner, numberOrNull };
