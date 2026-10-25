import { useState } from "react";

import {
  LIMITS,
  customScaleLabel,
  fixedOptions,
  isChoiceType,
  isNumericType,
  questionHasMerchantOptions,
  type QuestionType,
  type SurveyQuestionDef,
} from "@shared/survey-rules";
import { planHas, type PlanTier } from "@shared/plan-features";
import type { EditorSurvey } from "~/lib/surveys.server";
import type { PresetLabels } from "~/lib/channel-presets.server";
import { JustInTimeNotice } from "~/components/data-notice";
import { CountrySelect, countryName } from "~/components/country-select";
import { CountryPicker } from "~/components/country-picker";
import { mergePresetAnswers, presetAnswersForCountry, type PresetAnswer } from "~/lib/preset-options";

/** What the editor needs to offer country presets (F2/F3). */
export type PresetContext = {
  labels: PresetLabels;
  /** The store's own country, preselected. */
  shopCountry: string | null;
  /** The merchant's admin language, for country names. */
  language: string;
};

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

/**
 * Keep every follow-up condition one the server accepts, after any edit.
 *
 * The editor used to let a merchant build states that every save refused:
 * remove the answer a follow-up waits for, change the parent question to a
 * type with other answers, or move the follow-up above its parent. The save
 * then failed with `show_if_option_unknown` / `show_if_unknown` and the
 * merchant had to work out why. Now an answer that no longer exists is dropped
 * from the condition, and a condition that can no longer work (its parent is
 * gone, after it, or of the wrong kind) is removed, which makes the follow-up
 * an ordinary question, the same thing removing its parent always did.
 * A condition still being set up (parent picked, no answer ticked yet) is left
 * alone.
 */
export function repairFollowUps<Q extends Pick<Question, "id" | "type" | "showIf" | "options">>(questions: Q[]): Q[] {
  let changed = false;
  const next = questions.map((question, index) => {
    const condition = question.showIf;
    if (!condition?.questionId) return question;
    const parentIndex = questions.findIndex((q) => q.id === condition.questionId);
    const parent = parentIndex >= 0 ? questions[parentIndex] : undefined;
    const drop = () => {
      changed = true;
      return { ...question, showIf: null };
    };
    if (!parent || parentIndex >= index) return drop();
    if (condition.optionIds && condition.optionIds.length > 0) {
      if (!isChoiceType(parent.type)) return drop();
      const allowed = questionHasMerchantOptions(parent.type)
        ? new Set(parent.options.map((o) => o.id))
        : new Set(fixedOptions(parent as unknown as SurveyQuestionDef).map((o) => o.id));
      const kept = condition.optionIds.filter((id) => allowed.has(id));
      if (kept.length === condition.optionIds.length) return question;
      if (kept.length === 0) return drop();
      changed = true;
      return { ...question, showIf: { ...condition, optionIds: kept } };
    }
    if ((typeof condition.min === "number" || typeof condition.max === "number") && !isNumericType(parent.type)) {
      return drop();
    }
    return question;
  });
  return changed ? next : questions;
}

export function QuestionList({
  draft,
  update: updateSurvey,
  t,
  limits,
  errors,
  plan,
  presets,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
  plan: PlanTier;
  /** Absent: the country presets are not offered. */
  presets?: PresetContext;
}) {
  const questions = draft.questions;
  // Every change to the questions goes through the follow-up repair.
  const update = (patch: Partial<EditorSurvey>) =>
    updateSurvey(patch.questions ? { ...patch, questions: repairFollowUps(patch.questions) } : patch);

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
          presets={presets}
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
  presets,
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
  presets?: PresetContext;
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
              // A follow-up never moves above the question it depends on.
              disabled={index === 0 || questions[index - 1]?.id === question.showIf?.questionId || undefined}
              onClick={() => onMove(index, index - 1)}
            />
            <s-button
              type="button"
              variant="tertiary"
              icon="arrow-down"
              accessibilityLabel={t("editor.move_down")}
              disabled={index === questions.length - 1 || questions[index + 1]?.showIf?.questionId === question.id || undefined}
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
          details={t("editor.answer_type_details")}
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
          <AnswerList
            question={question}
            index={index}
            setQuestion={setQuestion}
            t={t}
            limits={limits}
            errors={errors}
            presets={presets}
            plan={plan}
          />
        ) : null}

        <s-checkbox
          label={t("editor.required")}
          details={t("editor.required_details")}
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
                  details={t("editor.long_answer_details")}
                  checked={question.textMultiline || undefined}
                  onChange={(e: Event) => setQuestion(index, { textMultiline: checkboxChecked(e) })}
                />
                <TextField
                  label={t("editor.placeholder")}
                  details={t("editor.placeholder_details")}
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
  presets,
  plan,
}: {
  question: Question;
  index: number;
  setQuestion: (index: number, patch: Partial<Question>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
  presets?: PresetContext;
  plan: PlanTier;
}) {
  const options = question.options.filter((o) => !o.isOther);
  const others = question.options.filter((o) => o.isOther);
  const count = options.length;
  // An "Other (please specify)" option is an answer too: the server counts
  // every option against the limit, so the merchant's own answers get the rest.
  const max = Math.max(limits.MIN_OPTIONS, limits.MAX_OPTIONS - others.length);
  // The answer whose country list is open (F4), if any.
  const [countriesFor, setCountriesFor] = useState<string | null>(null);
  const language = presets?.language ?? "en";
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
        <s-stack key={option.id || `new-${i}`} gap="small-200">
        <s-grid gridTemplateColumns="minmax(0, 1fr) auto auto" gap="small" alignItems="center">
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
          <s-button
            type="button"
            variant="tertiary"
            icon="globe"
            accessibilityLabel={t("editor.answer_countries_button", { label: option.label })}
            onClick={() => setCountriesFor(countriesFor === option.id ? null : option.id)}
          />
        </s-grid>
        {(option.countries?.length ?? 0) > 0 && countriesFor !== option.id ? (
          <s-text color="subdued" fontSize="small">
            {t("editor.answer_countries_summary", {
              list: (option.countries ?? []).map((code) => countryName(code, language)).join(", "),
            })}
          </s-text>
        ) : null}
        {countriesFor === option.id ? (
          // F4: a Growth rule, like the survey's own country list. An answer
          // that already has one keeps its control after a downgrade.
          !planHas(plan, "advanced_targeting") && (option.countries?.length ?? 0) === 0 ? (
            <LockedNote t={t} plan="growth">{t("editor.answer_countries_locked", { plan: t("plans.growth") })}</LockedNote>
          ) : (
            <CountryPicker
              value={option.countries ?? []}
              onChange={(codes) => setOptions(options.map((o, j) => (j === i ? { ...o, countries: codes } : o)))}
              language={language}
              label={t("editor.answer_countries_title", { label: option.label })}
              details={t("editor.answer_countries_details")}
              t={t}
            />
          )
        ) : null}
        </s-stack>
      ))}
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button
          type="button"
          variant="tertiary"
          icon="plus"
          disabled={count >= max || undefined}
          onClick={() => setOptions([...options, newOption(t("editor.new_answer", { n: count + 1 }))])}
        >
          {t("editor.add_answer")}
        </s-button>
        <s-text color="subdued" fontSize="small">
          {t("editor.answer_count", { count, max })}
        </s-text>
      </s-stack>
      {presets ? (
        <details className="st-details">
          <summary>{t("presets.load_title")}</summary>
          <PresetLoader
            question={question}
            options={options}
            presets={presets}
            max={max}
            plan={plan}
            onApply={(next) => setOptions(next)}
            t={t}
          />
        </details>
      ) : null}
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
 * How the survey looks and the words around the questions (title, intro,
 * button, thank-you). Rewording one drops its translations, as for questions.
 *
 * Every setting here is applied by the checkout block and by the preview.
 * Colours and fonts are not here on purpose: checkout UI extensions cannot set
 * them, they always follow the store's checkout branding, and the section says
 * so instead of offering a picker that would do nothing.
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
  const setDesign = (patch: Partial<EditorSurvey["design"]>) => update({ design: { ...design, ...patch } });
  const setScale = (field: "scaleLowLabel" | "scaleHighLabel", value: string) =>
    update({
      design: { ...design, [field]: value },
      translations: withoutTranslatedField(draft.translations, field),
    });
  const hasRating = draft.questions.some((q) => q.type === "rating_5");
  const hasScale = hasRating || draft.questions.some((q) => q.type === "nps");

  return (
    <s-stack gap="base">
      <s-banner tone="info">{t("editor.look_help")}</s-banner>
      <s-select
        label={t("editor.layout")}
        details={t("editor.layout_details")}
        value={draft.layout}
        onChange={(e: Event) => {
          const layout = fieldValue(e) as "all" | "one_by_one";
          update({ layout, design: { ...design, layout } });
        }}
      >
        <s-option value="all">{t("editor.layout_all")}</s-option>
        <s-option value="one_by_one">{t("editor.layout_one")}</s-option>
      </s-select>
      {draft.layout === "one_by_one" ? (
        <s-switch
          label={t("editor.show_progress")}
          checked={design.showProgress || undefined}
          onChange={(e: Event) => setDesign({ showProgress: checkboxChecked(e) })}
        />
      ) : null}
      <s-switch
        label={t("editor.show_title")}
        details={t("editor.show_title_details")}
        checked={design.showTitle || undefined}
        onChange={(e: Event) => setDesign({ showTitle: checkboxChecked(e) })}
      />
      <TextField
        label={t("editor.title")}
        details={t("editor.title_details")}
        value={draft.title}
        maxLength={limits.MAX_SURVEY_TITLE}
        onInput={(v) => setText("title", v)}
      />
      <TextField
        label={t("editor.intro")}
        details={t("editor.intro_details")}
        value={draft.intro ?? ""}
        maxLength={limits.MAX_INTRO_TEXT}
        onInput={(v) => setText("intro", v)}
      />
      <TextField
        label={t("editor.button")}
        details={t("editor.button_details")}
        value={draft.buttonLabel}
        maxLength={limits.MAX_BUTTON_LABEL}
        onInput={(v) => setText("buttonLabel", v)}
      />
      <TextField
        label={t("editor.thanks")}
        details={t("editor.thanks_details")}
        value={draft.thankYouText}
        maxLength={limits.MAX_THANK_YOU_TEXT}
        onInput={(v) => setText("thankYouText", v)}
      />
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 12rem), 1fr))" gap="small">
        <s-select
          label={t("editor.frame")}
          details={t("editor.frame_details")}
          value={design.cardBorder}
          onChange={(e: Event) => setDesign({ cardBorder: fieldValue(e) === "no_border" ? "no_border" : "border" })}
        >
          <s-option value="border">{t("editor.frame_border")}</s-option>
          <s-option value="no_border">{t("editor.frame_none")}</s-option>
        </s-select>
        <s-select
          label={t("editor.spacing")}
          value={design.spacing}
          onChange={(e: Event) => setDesign({ spacing: fieldValue(e) === "compact" ? "compact" : "comfortable" })}
        >
          <s-option value="comfortable">{t("editor.spacing_comfortable")}</s-option>
          <s-option value="compact">{t("editor.spacing_compact")}</s-option>
        </s-select>
      </s-grid>
      {hasRating ? (
        <s-select
          label={t("editor.rating_style")}
          details={t("editor.rating_style_details")}
          value={design.ratingStyle}
          onChange={(e: Event) => setDesign({ ratingStyle: fieldValue(e) === "stars" ? "stars" : "numbers" })}
        >
          <s-option value="numbers">{t("editor.rating_numbers")}</s-option>
          <s-option value="stars">{t("editor.rating_stars")}</s-option>
        </s-select>
      ) : null}
      {hasScale ? (
        <s-stack gap="small-200">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 12rem), 1fr))" gap="small">
            <TextField
              label={t("editor.scale_low")}
              value={customScaleLabel(design.scaleLowLabel) ?? ""}
              maxLength={limits.MAX_SCALE_LABEL}
              onInput={(v) => setScale("scaleLowLabel", v)}
            />
            <TextField
              label={t("editor.scale_high")}
              value={customScaleLabel(design.scaleHighLabel) ?? ""}
              maxLength={limits.MAX_SCALE_LABEL}
              onInput={(v) => setScale("scaleHighLabel", v)}
            />
          </s-grid>
          <s-text color="subdued" fontSize="small">
            {t("editor.scale_details")}
          </s-text>
        </s-stack>
      ) : null}
    </s-stack>
  );
}

/**
 * "Use answers for a country" (F3): load the usual channels of the market a
 * country belongs to into this question, replacing its answers or adding the
 * missing ones. Answers the question already had keep their ids, so their
 * results stay with them.
 */
function PresetLoader({
  question,
  options,
  presets,
  max,
  plan,
  onApply,
  t,
}: {
  question: Question;
  options: Option[];
  presets: PresetContext;
  max: number;
  plan: PlanTier;
  onApply: (next: Option[]) => void;
  t: TFn;
}) {
  const [country, setCountry] = useState<string>(presets.shopCountry ?? "US");
  // F4: answers added for another market can be shown only to its buyers.
  const [onlyThere, setOnlyThere] = useState(false);
  const { market, answers } = presetAnswersForCountry(country, presets.labels, question.templateKey);
  const canLimit = planHas(plan, "advanced_targeting") && market.countries.length > 0;
  const build = (answer: PresetAnswer, limitTo: readonly string[] = []): Option => ({
    id: newItemId(),
    label: answer.label,
    isOther: false,
    exclusive: false,
    archived: false,
    translations: answer.translations,
    templateKey: answer.templateKey,
    ...(limitTo.length > 0 ? { countries: [...limitTo] } : {}),
  });
  const name = countryName(country, presets.language);
  const missing = answers.filter((a) => !options.some((o) => o.label.trim().toLowerCase() === a.label.trim().toLowerCase()));
  const full = options.length >= max;
  // Replacing drops the merchant's own answers the preset does not have, so it
  // asks first, naming them. Nothing to drop: it applies at once.
  const replaced = mergePresetAnswers(options, answers, "replace", max, build);
  const dropped = options.filter((option) => !replaced.includes(option));
  const [confirmReplace, setConfirmReplace] = useState(false);
  const replace = () => {
    setConfirmReplace(false);
    onApply(replaced);
  };

  return (
    <s-stack gap="small">
      <s-text color="subdued">{t("presets.load_help")}</s-text>
      <CountrySelect
        value={country}
        onChange={(code) => {
          setCountry(code);
          setConfirmReplace(false);
        }}
        language={presets.language}
        label={t("presets.country_label")}
        searchLabel={t("presets.search")}
        noMatch={t("presets.no_match")}
      />
      <s-text>{t("presets.preview", { country: name, list: answers.map((a) => a.label).join(", ") })}</s-text>
      <s-stack direction="inline" gap="small">
        <s-button type="button" onClick={() => (dropped.length > 0 ? setConfirmReplace(true) : replace())}>
          {t("presets.replace")}
        </s-button>
        <s-button
          type="button"
          variant="tertiary"
          disabled={full || missing.length === 0 || undefined}
          onClick={() =>
            onApply(
              mergePresetAnswers(options, answers, "add", max, (answer) =>
                build(answer, onlyThere && canLimit ? market.countries : []),
              ),
            )
          }
        >
          {t("presets.add", { count: Math.min(missing.length, Math.max(0, max - options.length)) })}
        </s-button>
      </s-stack>
      {confirmReplace && dropped.length > 0 ? (
        <s-banner tone="warning">
          <s-stack gap="small">
            <s-text>{t("presets.replace_confirm", { list: dropped.map((option) => option.label).join(", ") })}</s-text>
            <s-stack direction="inline" gap="small">
              <s-button type="button" variant="primary" onClick={replace}>
                {t("presets.replace_confirm_yes")}
              </s-button>
              <s-button type="button" variant="tertiary" onClick={() => setConfirmReplace(false)}>
                {t("presets.replace_cancel")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      ) : null}
      {market.countries.length > 0 ? (
        planHas(plan, "advanced_targeting") ? (
          <s-checkbox
            label={t("presets.only_there", { country: name })}
            details={t("presets.only_there_details")}
            checked={onlyThere || undefined}
            onChange={(e: Event) => setOnlyThere(checkboxChecked(e))}
          />
        ) : (
          <LockedNote t={t} plan="growth">{t("presets.only_there_locked", { plan: t("plans.growth") })}</LockedNote>
        )
      ) : null}
      <s-text color="subdued" fontSize="small">
        {full ? t("presets.full", { max }) : t("presets.replace_note")}
      </s-text>
    </s-stack>
  );
}
