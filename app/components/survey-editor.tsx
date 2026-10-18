import { useState } from "react";

import {
  LIMITS,
  fixedOptions,
  isChoiceType,
  isNumericType,
  questionHasMerchantOptions,
  type QuestionType,
  type SurveyQuestionDef,
} from "@shared/survey-rules";
import { planHas, type PlanTier } from "@shared/plan-features";
import type { EditorSurvey } from "~/lib/surveys.server";
import { JustInTimeNotice } from "~/components/data-notice";

/**
 * The question editor: one card per question, in the order buyers see them.
 *
 * Each card shows only what most merchants change (the question, its answers,
 * whether it is required and when it is asked). Everything else sits behind
 * "More options" on the card, so a template can be checked and launched
 * without reading a single setting.
 *
 * Rewording a question or an answer drops its stored translations: a buyer in
 * another language then reads the merchant's new wording rather than an
 * outdated translation of the old one. The Languages section can translate it
 * again.
 */

/** The admin translator. */
export type TFn = import("~/lib/i18n").TFunction;

type Question = EditorSurvey["questions"][number];
type Option = Question["options"][number];

/**
 * A placeholder id for a question or option added in the editor. Unique, so two
 * new options never collide as duplicates and a follow-up can point at an item
 * added in the same edit; the server swaps it for the saved id.
 */
function newItemId(): string {
  return `new_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Answer types, in the order merchants reach for them. */
const QUESTION_TYPES: Array<{ type: QuestionType; key: string }> = [
  { type: "single_choice", key: "editor.type_single" },
  { type: "multi_choice", key: "editor.type_multi" },
  { type: "dropdown", key: "editor.type_dropdown" },
  { type: "yes_no", key: "editor.type_yesno" },
  { type: "rating_5", key: "editor.type_rating" },
  { type: "satisfaction_5", key: "editor.type_satisfaction" },
  { type: "nps", key: "editor.type_nps" },
  { type: "text", key: "editor.type_text" },
];

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

export function numberOrNull(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A translation map with one field removed from every language. */
export function withoutTranslatedField(translations: unknown, field: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!translations || typeof translations !== "object") return out;
  for (const [code, entry] of Object.entries(translations as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const rest = { ...(entry as Record<string, unknown>) };
    delete rest[field];
    if (Object.keys(rest).length > 0) out[code] = rest;
  }
  return out;
}

/**
 * Survey-level translations with one question's text removed. Older surveys
 * store question text under `translations[code].questions[id]`.
 */
function withoutLegacyQuestionText(translations: Record<string, unknown>, questionId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [code, entry] of Object.entries(translations)) {
    if (!entry || typeof entry !== "object") continue;
    const pack = { ...(entry as Record<string, unknown>) };
    const questions = pack.questions as Record<string, unknown> | undefined;
    if (questions && questionId in questions) {
      const next = { ...questions };
      delete next[questionId];
      pack.questions = next;
    }
    out[code] = pack;
  }
  return out;
}

/**
 * The options a follow-up can depend on: the merchant's own answers, or the
 * fixed Yes / No and satisfaction answers.
 */
function conditionOptions(question: Question | undefined, t: TFn): Array<{ id: string; label: string }> {
  if (!question) return [];
  if (questionHasMerchantOptions(question.type)) {
    return question.options.filter((o) => !o.isOther).map((o) => ({ id: o.id, label: o.label }));
  }
  return fixedOptions(question as SurveyQuestionDef).map((o) => ({
    id: o.id,
    label: question.type === "yes_no" ? t(o.id === "yes" ? "surveys.yes" : "surveys.no") : t(`surveys.satisfaction_${o.id}`),
  }));
}

export function TextField({
  label,
  value,
  maxLength,
  onInput,
  placeholder,
  details,
  multiline,
  error,
  errorPath,
}: {
  label: string;
  value: string;
  maxLength?: number;
  onInput: (value: string) => void;
  placeholder?: string;
  details?: string;
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
        details={details}
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
      details={details}
      error={error}
      onInput={(e: Event) => onInput(fieldValue(e))}
    />
  );
}

/** A plan-locked note with a way to upgrade. */
export function LockedNote({ t, plan, children }: { t: TFn; plan: PlanTier; children?: string }) {
  return (
    <s-box padding="small" borderRadius="base" background="subdued">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-icon type="lock" />
        <s-text>{children ?? t("editor.locked", { plan: t(`plans.${plan}`) })}</s-text>
        <s-link href="/app/plans">{t("editor.see_plans")}</s-link>
      </s-stack>
    </s-box>
  );
}

export function QuestionList({
  draft,
  update,
  t,
  limits,
  errors,
  plan,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
  plan: PlanTier;
}) {
  const questions = draft.questions;

  const setQuestion = (index: number, patch: Partial<Question>) => {
    const current = questions[index];
    if (!current) return;
    let next: Question = { ...current, ...patch };
    let surveyTranslations = draft.translations;
    for (const field of ["text", "helpText", "placeholder"] as const) {
      if (field in patch && patch[field] !== current[field]) {
        next = { ...next, translations: withoutTranslatedField(next.translations, field) as Question["translations"] };
        if (field === "text") surveyTranslations = withoutLegacyQuestionText(surveyTranslations, current.id);
      }
    }
    update({ questions: questions.map((q, i) => (i === index ? next : q)), translations: surveyTranslations });
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
          id: newItemId(),
          type: "single_choice",
          text: "",
          required: false,
          allowOther: false,
          translations: {},
          options: [newOption(t("editor.new_answer", { n: 1 })), newOption(t("editor.new_answer", { n: 2 }))],
        },
      ],
    });
  };

  const removeQuestion = (index: number) => {
    const removed = questions[index];
    // A follow-up that pointed at the removed question would never be asked.
    // Make it an ordinary question rather than silently hiding it.
    update({
      questions: questions
        .filter((_, i) => i !== index)
        .map((q) => (removed && q.showIf?.questionId === removed.id ? { ...q, showIf: null } : q)),
    });
  };

  const duplicateQuestion = (index: number) => {
    if (questions.length >= limits.MAX_QUESTIONS) return;
    const source = questions[index];
    if (!source) return;
    const copy: Question = {
      ...source,
      id: newItemId(),
      templateKey: null,
      options: source.options.map((o) => ({ ...o, id: newItemId(), templateKey: null })),
    };
    const next = [...questions];
    next.splice(index + 1, 0, copy);
    update({ questions: next });
  };

  return (
    <s-stack gap="base">
      {questions.map((question, index) => (
        <QuestionCard
          key={question.id || `new-${index}`}
          question={question}
          index={index}
          questions={questions}
          setQuestion={(i, patch) => {
            // A question that stops being single choice can no longer feed the
            // channel report.
            if (patch.type && !isChannelType(patch.type) && draft.channelReportQuestionId === question.id) {
              setQuestion(i, patch);
              update({ channelReportQuestionId: null });
              return;
            }
            setQuestion(i, patch);
          }}
          isChannelQuestion={Boolean(question.id) && draft.channelReportQuestionId === question.id}
          onChannelQuestion={(on) => update({ channelReportQuestionId: on ? question.id : null })}
          onMove={moveQuestion}
          onDuplicate={duplicateQuestion}
          onRemove={removeQuestion}
          canAdd={questions.length < limits.MAX_QUESTIONS}
          t={t}
          limits={limits}
          errors={errors}
          plan={plan}
        />
      ))}

      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-button type="button" icon="plus" onClick={addQuestion} disabled={questions.length >= limits.MAX_QUESTIONS || undefined}>
            {t("editor.add_question")}
          </s-button>
          <s-text color="subdued" fontSize="small">
            {t("editor.question_count", { count: questions.length, max: limits.MAX_QUESTIONS })}
          </s-text>
        </s-stack>
        {questions.length > limits.RECOMMENDED_MAX_QUESTIONS ? (
          <s-text color="subdued" fontSize="small">
            {t("editor.too_many_tip", { n: limits.RECOMMENDED_MAX_QUESTIONS })}
          </s-text>
        ) : null}
      </s-stack>
    </s-stack>
  );
}

function newOption(label: string): Option {
  return { id: newItemId(), label, isOther: false, exclusive: false, archived: false, translations: {} };
}

/** Question types whose answer can be a channel ("How did you hear about us?"). */
function isChannelType(type: QuestionType): boolean {
  return type === "single_choice" || type === "dropdown";
}

function QuestionCard({
  question,
  index,
  questions,
  setQuestion,
  isChannelQuestion,
  onChannelQuestion,
  onMove,
  onDuplicate,
  onRemove,
  canAdd,
  t,
  limits,
  errors,
  plan,
}: {
  question: Question;
  index: number;
  questions: Question[];
  setQuestion: (index: number, patch: Partial<Question>) => void;
  isChannelQuestion: boolean;
  onChannelQuestion: (on: boolean) => void;
  onMove: (index: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  canAdd: boolean;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
  plan: PlanTier;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isFollowUp = Boolean(question.showIf?.questionId);

  return (
    <s-box id={`q-${question.id || `new-${index}`}`} padding="base" border="base" borderRadius="large">
      <s-stack gap="base">
        <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text type="strong">{t("editor.question_n", { n: index + 1 })}</s-text>
            {isFollowUp ? <s-badge tone="info">{t("editor.follow_up_badge")}</s-badge> : null}
          </s-stack>
          <s-stack direction="inline" gap="small-200">
            <s-button
              type="button"
              variant="tertiary"
              icon="arrow-up"
              accessibilityLabel={t("editor.move_up")}
              disabled={index === 0 || undefined}
              onClick={() => onMove(index, index - 1)}
            />
            <s-button
              type="button"
              variant="tertiary"
              icon="arrow-down"
              accessibilityLabel={t("editor.move_down")}
              disabled={index === questions.length - 1 || undefined}
              onClick={() => onMove(index, index + 1)}
            />
            <s-button
              type="button"
              variant="tertiary"
              icon="duplicate"
              accessibilityLabel={t("editor.duplicate")}
              disabled={!canAdd || undefined}
              onClick={() => onDuplicate(index)}
            />
            <s-button
              type="button"
              variant="tertiary"
              tone="critical"
              icon="delete"
              accessibilityLabel={t("editor.remove")}
              onClick={() => setConfirmRemove(true)}
            />
          </s-stack>
        </s-grid>

        {confirmRemove ? (
          <s-banner tone="warning">
            <s-stack gap="small">
              <s-text>{t("editor.remove_confirm")}</s-text>
              <s-stack direction="inline" gap="small">
                <s-button type="button" tone="critical" onClick={() => onRemove(index)}>
                  {t("editor.remove")}
                </s-button>
                <s-button type="button" onClick={() => setConfirmRemove(false)}>
                  {t("common.cancel")}
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        ) : null}

        <TextField
          label={t("editor.question_text")}
          value={question.text}
          maxLength={limits.MAX_QUESTION_TEXT}
          placeholder={t("editor.question_placeholder")}
          error={errors.get(`questions[${index}].text`)}
          errorPath={`questions[${index}].text`}
          onInput={(v) => setQuestion(index, { text: v })}
        />

        <s-select
          label={t("editor.answer_type")}
          value={question.type}
          error={errors.get(`questions[${index}].type`)}
          onChange={(e: Event) => setQuestion(index, { type: fieldValue(e) as QuestionType })}
        >
          {QUESTION_TYPES.map((entry) => (
            <s-option key={entry.type} value={entry.type}>
              {t(entry.key)}
            </s-option>
          ))}
        </s-select>

        {questionHasMerchantOptions(question.type) ? (
          <AnswerList question={question} index={index} setQuestion={setQuestion} t={t} limits={limits} errors={errors} />
        ) : null}

        <s-checkbox
          label={t("editor.required")}
          checked={question.required || undefined}
          onChange={(e: Event) => setQuestion(index, { required: checkboxChecked(e) })}
        />

        {/* Which question is "how did you hear about us?". Only that one feeds
            the Channel report and the attribution numbers on the Dashboard; a
            gift or price question counted there would show up as channels. */}
        {isChannelType(question.type) ? (
          <s-checkbox
            label={t("editor.channel_question")}
            details={t("editor.channel_question_details")}
            checked={isChannelQuestion || undefined}
            onChange={(e: Event) => onChannelQuestion(checkboxChecked(e))}
          />
        ) : null}

        <FollowUpEditor question={question} index={index} questions={questions} setQuestion={setQuestion} t={t} />

        <details className="st-details">
          <summary>{t("editor.more_options")}</summary>
          <s-stack gap="base">
            <TextField
              label={t("editor.help_text")}
              details={t("editor.help_text_details")}
              value={question.helpText ?? ""}
              maxLength={limits.MAX_HELP_TEXT}
              onInput={(v) => setQuestion(index, { helpText: v || null })}
            />
            {questionHasMerchantOptions(question.type) ? (
              <s-switch
                label={t("editor.shuffle")}
                details={t("editor.shuffle_details")}
                checked={question.randomizeOptions || undefined}
                onChange={(e: Event) => setQuestion(index, { randomizeOptions: checkboxChecked(e) })}
              />
            ) : null}
            {question.type === "multi_choice" ? (
              <>
                <s-number-field
                  label={t("editor.max_answers")}
                  details={t("editor.max_answers_details")}
                  min={1}
                  max={limits.MAX_OPTIONS}
                  value={question.maxSelections != null ? String(question.maxSelections) : ""}
                  onInput={(e: Event) => {
                    const max = numberOrNull(fieldValue(e));
                    setQuestion(index, { maxSelections: max, minSelections: max ? Math.min(question.minSelections ?? 1, max) : question.minSelections ?? null });
                  }}
                />
                <ExclusiveOption question={question} index={index} setQuestion={setQuestion} t={t} plan={plan} />
              </>
            ) : null}
            {question.type === "text" ? (
              <>
                <s-switch
                  label={t("editor.long_answer")}
                  checked={question.textMultiline || undefined}
                  onChange={(e: Event) => setQuestion(index, { textMultiline: checkboxChecked(e) })}
                />
                <TextField
                  label={t("editor.placeholder")}
                  value={question.placeholder ?? ""}
                  maxLength={limits.MAX_HELP_TEXT}
                  onInput={(v) => setQuestion(index, { placeholder: v || null })}
                />
                {/* Typed answers are the one place a buyer can volunteer
                    personal details, so say so where the question is made. */}
                <JustInTimeNotice>{t("privacy.text_warning")}</JustInTimeNotice>
              </>
            ) : null}
          </s-stack>
        </details>
      </s-stack>
    </s-box>
  );
}

function AnswerList({
  question,
  index,
  setQuestion,
  t,
  limits,
  errors,
}: {
  question: Question;
  index: number;
  setQuestion: (index: number, patch: Partial<Question>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
}) {
  const options = question.options.filter((o) => !o.isOther);
  const others = question.options.filter((o) => o.isOther);
  const count = options.length;
  const setOptions = (next: Option[]) => setQuestion(index, { options: [...next, ...others] });
  const optionsError = errors.get(`questions[${index}].options`);

  return (
    <s-stack gap="small">
      <s-text type="strong">{t("editor.answers")}</s-text>
      {optionsError ? (
        <s-banner tone="critical" id={errorId(`questions[${index}].options`)}>
          {optionsError}
        </s-banner>
      ) : null}
      {options.map((option, i) => (
        <s-grid key={option.id || `new-${i}`} gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
          <s-text-field
            id={errorId(`questions[${index}].options[${i}].label`)}
            label={t("editor.answer_n", { n: i + 1 })}
            labelAccessibilityVisibility="exclusive"
            value={option.label}
            maxLength={limits.MAX_OPTION_LABEL}
            error={errors.get(`questions[${index}].options[${i}].label`)}
            onInput={(e: Event) => {
              const label = fieldValue(e);
              // A reworded answer drops its translations (see the file header).
              setOptions(options.map((o, j) => (j === i ? { ...o, label, translations: label === o.label ? o.translations : {} } : o)));
            }}
          />
          <s-button
            type="button"
            variant="tertiary"
            icon="x"
            accessibilityLabel={t("editor.remove_answer", { label: option.label })}
            disabled={count <= limits.MIN_OPTIONS || undefined}
            onClick={() => setOptions(options.filter((_, j) => j !== i))}
          />
        </s-grid>
      ))}
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button
          type="button"
          variant="tertiary"
          icon="plus"
          disabled={count >= limits.MAX_OPTIONS || undefined}
          onClick={() => setOptions([...options, newOption(t("editor.new_answer", { n: count + 1 }))])}
        >
          {t("editor.add_answer")}
        </s-button>
        <s-text color="subdued" fontSize="small">
          {t("editor.answer_count", { count, max: limits.MAX_OPTIONS })}
        </s-text>
      </s-stack>
      {/* A template's "Other (please specify)" is a real option, not the
          `allowOther` flag, so the switch reads both and turning it off
          removes the option too. Before, that option was hidden here and the
          switch read off while buyers still saw it. */}
      <s-switch
        label={t("editor.allow_other")}
        details={t("editor.allow_other_details")}
        checked={question.allowOther || others.length > 0 || undefined}
        onChange={(e: Event) =>
          checkboxChecked(e)
            ? setQuestion(index, { allowOther: true })
            : setQuestion(index, { allowOther: false, options: options })
        }
      />
      {others.map((other) => (
        <s-text-field
          key={other.id || "other"}
          label={t("editor.other_label")}
          value={other.label}
          maxLength={limits.MAX_OPTION_LABEL}
          onInput={(e: Event) => {
            const label = fieldValue(e);
            setQuestion(index, {
              options: question.options.map((o) =>
                o === other ? { ...o, label, translations: label === o.label ? o.translations : {} } : o,
              ),
            });
          }}
        />
      ))}
    </s-stack>
  );
}

/** "None of these" style answer that clears the others (T6, Growth). */
function ExclusiveOption({
  question,
  index,
  setQuestion,
  t,
  plan,
}: {
  question: Question;
  index: number;
  setQuestion: (index: number, patch: Partial<Question>) => void;
  t: TFn;
  plan: PlanTier;
}) {
  const options = question.options.filter((o) => !o.isOther);
  const current = options.find((o) => o.exclusive)?.id ?? "";
  // A survey that already has one keeps it after a downgrade; the server
  // refuses only a new one.
  if (!planHas(plan, "full_templates") && !current) {
    return <LockedNote t={t} plan="growth">{t("editor.exclusive_locked", { plan: t("plans.growth") })}</LockedNote>;
  }
  return (
    <s-select
      label={t("editor.exclusive")}
      details={t("editor.exclusive_details")}
      value={current}
      onChange={(e: Event) => {
        const id = fieldValue(e);
        setQuestion(index, {
          options: question.options.map((o) => (o.isOther ? o : { ...o, exclusive: id !== "" && o.id === id })),
        });
      }}
    >
      <s-option value="">{t("editor.exclusive_none")}</s-option>
      {options.map((o) => (
        <s-option key={o.id} value={o.id}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

function FollowUpEditor({
  question,
  index,
  questions,
  setQuestion,
  t,
}: {
  question: Question;
  index: number;
  questions: Question[];
  setQuestion: (index: number, patch: Partial<Question>) => void;
  t: TFn;
}) {
  // Only an earlier choice or score question can trigger a follow-up; a
  // written answer has nothing to match on.
  const earlier = questions.slice(0, index).filter((q) => isChoiceType(q.type) || isNumericType(q.type));
  const condition = question.showIf;
  const parent = condition?.questionId ? questions.find((q) => q.id === condition.questionId) : undefined;

  if (earlier.length === 0 && !condition) return null;

  return (
    <s-stack gap="small">
      <s-select
        label={t("editor.when_asked")}
        value={condition?.questionId ?? ""}
        onChange={(e: Event) => {
          const value = fieldValue(e);
          setQuestion(index, { showIf: value ? { questionId: value, optionIds: [] } : null });
        }}
      >
        <s-option value="">{t("editor.always_ask")}</s-option>
        {earlier.map((q) => (
          <s-option key={q.id} value={q.id}>
            {t("editor.only_after", { n: questions.indexOf(q) + 1 })}
          </s-option>
        ))}
      </s-select>

      {condition?.questionId && parent ? (
        isNumericType(parent.type) ? (
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              {t("editor.score_between")}
            </s-text>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 11rem), 1fr))" gap="small">
              <s-number-field
                label={t("editor.score_min")}
                min={0}
                value={condition.min != null ? String(condition.min) : ""}
                onInput={(e: Event) => {
                  const raw = fieldValue(e);
                  setQuestion(index, { showIf: { ...condition, min: raw === "" ? undefined : Number(raw) } });
                }}
              />
              <s-number-field
                label={t("editor.score_max")}
                min={0}
                value={condition.max != null ? String(condition.max) : ""}
                onInput={(e: Event) => {
                  const raw = fieldValue(e);
                  setQuestion(index, { showIf: { ...condition, max: raw === "" ? undefined : Number(raw) } });
                }}
              />
            </s-grid>
          </s-stack>
        ) : (
          <s-stack gap="small-200">
            <s-text color="subdued" fontSize="small">
              {t("editor.when_answer_is")}
            </s-text>
            {conditionOptions(parent, t).map((option) => (
              <s-checkbox
                key={option.id}
                label={option.label}
                checked={(condition.optionIds ?? []).includes(option.id) || undefined}
                onChange={(e: Event) => {
                  const ids = new Set(condition.optionIds ?? []);
                  if (checkboxChecked(e)) ids.add(option.id);
                  else ids.delete(option.id);
                  setQuestion(index, { showIf: { ...condition, optionIds: [...ids] } });
                }}
              />
            ))}
          </s-stack>
        )
      ) : null}
    </s-stack>
  );
}

/**
 * The words around the questions (title, intro, button, thank-you) and how the
 * questions are laid out. Rewording one drops its translations, as for
 * questions.
 */
export function FrameText({
  draft,
  update,
  t,
  limits,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  limits: typeof LIMITS;
}) {
  const setText = (field: "title" | "intro" | "buttonLabel" | "thankYouText", value: string) => {
    const current = draft[field] ?? "";
    const next = field === "intro" ? value || null : value;
    if (value === current) return;
    update({ [field]: next, translations: withoutTranslatedField(draft.translations, field) } as Partial<EditorSurvey>);
  };
  const design = draft.design;

  return (
    <s-stack gap="base">
      <s-select
        label={t("editor.layout")}
        value={draft.layout}
        onChange={(e: Event) => {
          const layout = fieldValue(e) as "all" | "one_by_one";
          update({ layout, design: { ...design, layout } });
        }}
      >
        <s-option value="all">{t("editor.layout_all")}</s-option>
        <s-option value="one_by_one">{t("editor.layout_one")}</s-option>
      </s-select>
      <s-switch
        label={t("editor.show_title")}
        checked={design.showTitle || undefined}
        onChange={(e: Event) => update({ design: { ...design, showTitle: checkboxChecked(e) } })}
      />
      <TextField
        label={t("editor.title")}
        value={draft.title}
        maxLength={limits.MAX_SURVEY_TITLE}
        onInput={(v) => setText("title", v)}
      />
      <TextField
        label={t("editor.intro")}
        value={draft.intro ?? ""}
        maxLength={limits.MAX_INTRO_TEXT}
        onInput={(v) => setText("intro", v)}
      />
      <TextField
        label={t("editor.button")}
        value={draft.buttonLabel}
        maxLength={limits.MAX_BUTTON_LABEL}
        onInput={(v) => setText("buttonLabel", v)}
      />
      <TextField
        label={t("editor.thanks")}
        value={draft.thankYouText}
        maxLength={limits.MAX_THANK_YOU_TEXT}
        onInput={(v) => setText("thankYouText", v)}
      />
      {draft.questions.some((q) => q.type === "rating_5") ? (
        <s-select
          label={t("editor.rating_style")}
          value={design.ratingStyle}
          onChange={(e: Event) => update({ design: { ...design, ratingStyle: fieldValue(e) as "numbers" | "stars" } })}
        >
          <s-option value="numbers">{t("editor.rating_numbers")}</s-option>
          <s-option value="stars">{t("editor.rating_stars")}</s-option>
        </s-select>
      ) : null}
    </s-stack>
  );
}
