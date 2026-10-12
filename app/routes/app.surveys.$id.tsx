import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { AdvancedDisclosure, Banner, Panel } from "~/components/admin-ui";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { NotFoundError, ValidationError } from "~/lib/errors";
import { getEditorSurvey, updateSurvey, type EditorSurvey, type SurveyInput } from "~/lib/surveys.server";
import { grantedSyncScopes } from "~/lib/scopes.server";
import { DEFAULT_SURVEY_TEXT } from "@shared/survey-config";
import { LANGUAGES } from "~/lib/i18n";
import {
  LIMITS,
  fixedOptions,
  isChoiceType,
  isNumericType,
  questionHasMerchantOptions,
  type QuestionType,
  type SurveyQuestionDef,
} from "@shared/survey-rules";

import { SurveyPreview } from "~/components/survey-preview";
import { LogicMap } from "~/components/logic-map";

/**
 * Survey editor.
 *
 * Desktop: two columns, editor left and live preview right (sticky). Mobile:
 * stacked with the preview below.
 *
 * The whole survey is edited in local state and posted as one JSON blob, so
 * reordering and adding options never round-trip, and nothing is persisted until
 * Save. The contextual save bar (App Bridge `shopify.saveBar`) is driven from
 * the dirty state below.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "surveys.editor_title");

export const loader = guarded(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";
  const survey = await getEditorSurvey(shop.id, id).catch(() => null);
  if (!survey) throw new NotFoundError("That survey does not exist.", { surveyId: id });

  return {
    survey,
    // The shop's presentment currency, used for the order-value targeting copy.
    // The full currency list is fetched from Shopify in a later phase; the
    // store currency is enough for the editor label now.
    shopCurrency: "USD",
    languages: LANGUAGES.map((language) => ({ code: language.code, name: language.nativeName })),
    limits: LIMITS,
    defaults: DEFAULT_SURVEY_TEXT,
    // Which write scopes the merchant has granted. The sync section is shown,
    // but each write is gated on these, so a store that has not re-approved
    // keeps a fully working survey with sync skipped.
    grantedScopes: grantedSyncScopes(session.scope),
  };
});

export const action = guarded(async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";
  const form = await request.formData();
  const raw = form.get("survey");

  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("The survey was not submitted.", "Reload the page and save again.");
  }

  let input: SurveyInput;
  try {
    input = JSON.parse(raw) as SurveyInput;
  } catch {
    throw new ValidationError("The survey could not be read.", "Reload the page and save again.");
  }

  try {
    await updateSurvey(shop.id, id, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Validation failures are expected, not exceptional: return the issues so
      // the editor can mark each field instead of replacing the page with an
      // error boundary. `guarded` lets a thrown AppError through, so this catch
      // is what turns it into inline feedback.
      return { ok: false as const, issues: extractIssues(error) };
    }
    throw error;
  }
  return redirect(`/app/surveys/${id}?saved=1`);
});

/** Validation issues carried on a ValidationError, with a translated message. */
export type EditorIssue = { path: string; code: string; message: string };

function extractIssues(error: ValidationError): EditorIssue[] {
  const raw = error.fields.issues;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter(
        (i): i is EditorIssue =>
          typeof i === "object" && i !== null && typeof (i as EditorIssue).path === "string",
      )
      .map((i) => ({ path: i.path, code: i.code, message: i.message }));
  }
  const field = typeof error.fields.field === "string" ? error.fields.field : "";
  return [{ path: field, code: typeof error.fields.code === "string" ? error.fields.code : "invalid", message: error.message }];
}

/**
 * Translate a validator issue into the locale's own words.
 *
 * The shared validator emits a stable `code`; the English `message` stays as a
 * fallback for a code that has no key yet, so a new rule can never render a raw
 * translation key.
 */
function issueText(t: TFn, issue: EditorIssue): string {
  const key = `surveys.validation_${issue.code}`;
  const translated = t(key);
  return translated === key ? issue.message : translated;
}

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

export default function SurveyEditorRoute() {
  const { survey, shopCurrency, languages, limits, defaults, grantedScopes } = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();
  const navigation = useNavigation();

  const [draft, setDraft] = useState<EditorSurvey>(survey);
  const [saved, setSaved] = useState(false);
  const [view, setView] = useState<"questions" | "logic">("questions");
  const initial = useRef(JSON.stringify(survey));
  const actionData = useActionData<typeof action>();

  // path -> translated message, so each field can render its own error.
  const errors = useMemo(() => {
    const map = new Map<string, string>();
    if (actionData && actionData.ok === false) {
      for (const issue of actionData.issues) map.set(issue.path, issueText(t, issue));
    }
    return map;
  }, [actionData, t]);

  // Bring the first problem into view once the save round-trips, so a phone
  // user is not left staring at the Save button with the error off screen.
  const firstErrorPath = actionData && actionData.ok === false ? actionData.issues[0]?.path : undefined;
  useEffect(() => {
    if (!firstErrorPath) return;
    document.getElementById(errorId(firstErrorPath))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [firstErrorPath]);

  const dirty = JSON.stringify(draft) !== initial.current;
  const saving = navigation.state === "submitting";

  // Clear the dirty flag once the save round-trips.
  useEffect(() => {
    if (navigation.state === "idle" && !dirty) setSaved(false);
  }, [navigation.state, dirty]);

  // App Bridge contextual save bar: state-driven, never mixed with data-save-bar.
  useEffect(() => {
    const bridge = (globalThis as { shopify?: { saveBar?: SaveBarApi } }).shopify;
    if (!bridge?.saveBar) return;
    if (dirty) {
      bridge.saveBar.show("survey-editor");
    } else {
      bridge.saveBar.hide("survey-editor");
    }
  }, [dirty]);

  const update = (patch: Partial<EditorSurvey>) => setDraft((d) => ({ ...d, ...patch }));

  // Show-if logic is available on every plan in the shipped code (the Free plan
  // gates question COUNT, not conditional logic), so the Logic map is fully
  // editable everywhere. Recorded as an adaptation from the upgrade plan, which
  // scoped show-if to paid plans; the code is the source of truth here.
  const logicAllowed = true;

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-link href="/app/surveys">{t("surveys.back_to_list")}</s-link>
      </s-stack>

      <s-section heading={draft.name} subheading={t("surveys.editor_subtitle")} padding="none" />

      {draft.responseCount > 0 ? (
        <Banner tone="info" heading={t("surveys.has_responses_title")}>
          {t("surveys.has_responses_body")}
        </Banner>
      ) : null}

      {actionData && actionData.ok === false ? (
        <Banner tone="critical" heading={t("surveys.save_failed_title")}>
          {t("surveys.save_failed_body", { count: actionData.issues.length })}
        </Banner>
      ) : null}

      <Form method="post">
        <input type="hidden" name="survey" value={JSON.stringify(draft)} />

        <s-query-container>
          <s-grid gridTemplateColumns="@container (inline-size > 900px) minmax(0, 2fr) minmax(0, 1fr), 1fr" gap="base">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button
                  variant={view === "questions" ? "primary" : "secondary"}
                  onClick={() => setView("questions")}
                >
                  {t("surveys.section_questions")}
                </s-button>
                <s-button
                  variant={view === "logic" ? "primary" : "secondary"}
                  onClick={() => setView("logic")}
                >
                  {t("logic.tab")}
                </s-button>
              </s-stack>

              {view === "questions" ? (
                <Panel title={t("surveys.section_questions")}>
                  <QuestionList draft={draft} update={update} t={t} limits={limits} errors={errors} />
                </Panel>
              ) : (
                <Panel title={t("logic.tab")} description={t("logic.section_help")}>
                  <LogicMap
                    draft={draft}
                    update={update}
                    t={t}
                    maxQuestions={limits.MAX_QUESTIONS}
                    canUseLogic={logicAllowed}
                    onEditQuestion={(questionId) => {
                      setView("questions");
                      // Scroll to the question once the Questions view has
                      // rendered. Deferred a frame so the DOM exists.
                      requestAnimationFrame(() => {
                        document.getElementById(`q-${questionId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                      });
                    }}
                  />
                </Panel>
              )}

              <Panel title={t("surveys.section_text")}>
                <s-stack gap="base">
                  <TextField
                    label={t("surveys.field_title")}
                    value={draft.title}
                    maxLength={limits.MAX_SURVEY_TITLE}
                    onInput={(v) => update({ title: v })}
                  />
                  <TextField
                    label={t("surveys.field_intro")}
                    value={draft.intro ?? ""}
                    maxLength={limits.MAX_INTRO_TEXT}
                    onInput={(v) => update({ intro: v || null })}
                  />
                  <TextField
                    label={t("surveys.field_button")}
                    value={draft.buttonLabel}
                    maxLength={limits.MAX_BUTTON_LABEL}
                    onInput={(v) => update({ buttonLabel: v })}
                  />
                  <TextField
                    label={t("surveys.field_thank_you")}
                    value={draft.thankYouText}
                    maxLength={limits.MAX_THANK_YOU_TEXT}
                    onInput={(v) => update({ thankYouText: v })}
                  />
                </s-stack>
              </Panel>

              <Panel title={t("surveys.section_layout")}>
                <s-stack gap="small">
                  <s-select
                    label={t("surveys.section_layout")}
                    value={draft.layout}
                    onChange={(e: Event) => update({ layout: fieldValue(e) as "all" | "one_by_one" })}
                  >
                    <s-option value="all">{t("surveys.layout_all")}</s-option>
                    <s-option value="one_by_one">{t("surveys.layout_one")}</s-option>
                  </s-select>
                </s-stack>
              </Panel>

              <Panel title={t("surveys.section_placement")}>
                <s-stack gap="small">
                  {(["thank_you", "order_status"] as const).map((placement) => (
                    <s-checkbox
                      key={placement}
                      name={`placement-${placement}`}
                      label={t(`surveys.placement_${placement}`)}
                      checked={draft.placements.includes(placement) || undefined}
                      onChange={(e: Event) => {
                        const checked = checkboxChecked(e);
                        const next = checked
                          ? [...new Set([...draft.placements, placement])]
                          : draft.placements.filter((p) => p !== placement);
                        update({ placements: next });
                      }}
                    />
                  ))}
                  <s-text color="subdued" fontSize="small">
                    {t("surveys.placement_help")}
                  </s-text>
                </s-stack>
              </Panel>

              <Panel title={t("surveys.section_targeting")}>
                <Targeting draft={draft} update={update} shopCurrency={shopCurrency} t={t} limits={limits} />
              </Panel>

              <Panel title={t("surveys.section_sync")}>
                <SyncSettings draft={draft} update={update} t={t} grantedScopes={grantedScopes} />
              </Panel>

              <Panel title={t("surveys.section_translations")}>
                <Translations draft={draft} update={update} languages={languages} t={t} />
              </Panel>
            </s-stack>

            <s-stack gap="base">
              <s-box padding="small" border="base" borderRadius="base">
                <SurveyPreview survey={draft} languages={languages} t={t} />
              </s-box>
            </s-stack>
          </s-grid>
        </s-query-container>

        <s-box paddingBlockStart="base">
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" type="submit" loading={saving || undefined}>
              {saving ? t("common.saving") : t("surveys.save")}
            </s-button>
          </s-stack>
          {saved && !dirty ? (
            <s-text color="subdued" fontSize="small">
              {t("surveys.saved_note")}
            </s-text>
          ) : null}
        </s-box>
      </Form>
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type TFn = ReturnType<typeof useAdminI18n>["t"];

/** DOM id for a validator path, e.g. `questions[0].text` -> `err-questions-0-text`. */
function errorId(path: string): string {
  return `err-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * The options a show-if rule can reference on `question`: the merchant's own
 * options, or the fixed Yes / No and satisfaction options the shared rules
 * recognise. Mirrors `showIfOptionIds` so the editor offers exactly what the
 * validator will accept.
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

function fieldValue(event: Event): string {
  const target = event.currentTarget as { value?: unknown };
  return typeof target.value === "string" ? target.value : "";
}

function checkboxChecked(event: Event): boolean {
  const target = event.currentTarget as { checked?: unknown };
  return target.checked === true;
}

function TextField({
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

function QuestionList({
  draft,
  update,
  t,
  limits,
  errors,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  limits: typeof LIMITS;
  errors: Map<string, string>;
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
            { id: "", label: "Answer 1", isOther: false, archived: false, translations: {} },
            { id: "", label: "Answer 2", isOther: false, archived: false, translations: {} },
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
        >
          <s-stack gap="base">
            <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
              <s-text type="strong">
                {t("surveys.question_number", { n: index + 1, total: questions.length })}
              </s-text>
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
              <OptionEditor
                question={question}
                index={index}
                setQuestion={setQuestion}
                t={t}
                limits={limits}
                errors={errors}
              />
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

function numberOrNull(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
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

  const setOptions = (next: EditorSurvey["questions"][number]["options"]) =>
    setQuestion(index, { options: next });

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
        <s-stack key={option.id || `new-${i}`} direction="inline" gap="small" alignItems="end">
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
      ))}

      <s-stack direction="inline" gap="small">
        <s-button
          type="button"
          onClick={() =>
            setOptions([
              ...options,
              { id: "", label: t("surveys.new_option_label", { n: count + 1 }), isOther: false, archived: false, translations: {} },
              ...question.options.filter((o) => o.isOther),
            ])
          }
          disabled={count >= limits.MAX_OPTIONS || undefined}
        >
          {t("surveys.add_option")}
        </s-button>
      </s-stack>

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
  // Only earlier questions a condition can actually reference: choice types
  // (options) or the two score types (a numeric range). A text question can
  // never form a valid condition, so it is not offered.
  const referenceable = earlier.filter((q) => isChoiceType(q.type) || isNumericType(q.type));
  const condition = question.showIf;
  const conditionQuestion = condition?.questionId
    ? questions.find((q) => q.id === condition.questionId)
    : undefined;

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

function Targeting({
  draft,
  update,
  shopCurrency,
  t,
  limits,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  shopCurrency: string;
  t: TFn;
  limits: typeof LIMITS;
}) {
  const targeting = draft.targeting;

  const set = (patch: Partial<typeof targeting>) => update({ targeting: { ...targeting, ...patch } });

  return (
    <s-stack gap="base">
      <s-select
        label={t("surveys.target_customer_type")}
        value={targeting.customerType ?? "everyone"}
        onChange={(e: Event) => set({ customerType: fieldValue(e) as "everyone" | "first_order" | "returning" })}
      >
        <s-option value="everyone">{t("surveys.customer_everyone")}</s-option>
        <s-option value="first_order">{t("surveys.customer_first")}</s-option>
        <s-option value="returning">{t("surveys.customer_returning")}</s-option>
      </s-select>

      <s-stack direction="inline" gap="small">
        <NumberField
          label={t("surveys.target_min_value", { currency: shopCurrency })}
          value={targeting.minValue ?? null}
          onInput={(v) => set({ minValue: v })}
        />
        <NumberField
          label={t("surveys.target_max_value", { currency: shopCurrency })}
          value={targeting.maxValue ?? null}
          onInput={(v) => set({ maxValue: v })}
        />
      </s-stack>
      <s-text color="subdued" fontSize="small">
        {t("surveys.target_value_help", { currency: shopCurrency })}
      </s-text>

      <AdvancedDisclosure label={t("surveys.section_advanced")}>
        <s-stack gap="base">
          <s-number-field
            label={t("surveys.target_sample")}
            min={1}
            max={100}
            value={targeting.samplePercent != null ? String(targeting.samplePercent) : "100"}
            onInput={(e: Event) => set({ samplePercent: numberOrNull(fieldValue(e)) ?? 100 })}
          />
          <s-text-field
            label={t("surveys.target_countries")}
            value={(targeting.countries ?? []).join(", ")}
            onInput={(e: Event) =>
              set({
                countries: fieldValue(e)
                  .split(",")
                  .map((c) => c.trim().toUpperCase())
                  .filter(Boolean),
              })
            }
          />
          <s-text-field
            label={t("surveys.target_languages")}
            value={(targeting.languages ?? []).join(", ")}
            onInput={(e: Event) =>
              set({
                languages: fieldValue(e)
                  .split(",")
                  .map((l) => l.trim())
                  .filter(Boolean),
              })
            }
          />
      <s-stack direction="inline" gap="small">
        <s-text-field
          label={t("surveys.target_starts")}
          placeholder="YYYY-MM-DD"
          value={targeting.startsAt ? targeting.startsAt.slice(0, 10) : ""}
          onInput={(e: Event) => set({ startsAt: fieldValue(e) || null })}
        />
        <s-text-field
          label={t("surveys.target_ends")}
          placeholder="YYYY-MM-DD"
          value={targeting.endsAt ? targeting.endsAt.slice(0, 10) : ""}
          onInput={(e: Event) => set({ endsAt: fieldValue(e) || null })}
        />
      </s-stack>
      <NumberField
        label={t("surveys.target_max_responses")}
        value={targeting.maxResponses ?? null}
        onInput={(v) => set({ maxResponses: v })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.target_products_note", { max: limits.MAX_TARGET_PRODUCTS })}
      </s-text>
        </s-stack>
      </AdvancedDisclosure>
    </s-stack>
  );
}

function SyncSettings({
  draft,
  update,
  t,
  grantedScopes,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  grantedScopes: string[];
}) {
  const raw = (draft.syncOptions ?? {}) as {
    orderTags?: unknown;
    customerTags?: unknown;
    metafields?: unknown;
    flowTrigger?: unknown;
  };

  const tagText = (value: unknown): string => (Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : "");
  // Mirrors MAX_SYNC_TAGS in app/lib/sync.server.ts. A local constant, not an
  // import, because that module pulls in the database and must never reach the
  // browser bundle.
  const maxTags = 4;
  const parseTags = (value: string): string[] =>
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, maxTags);

  const set = (patch: Record<string, unknown>) => update({ syncOptions: { ...raw, ...patch } });

  const writeOrders = grantedScopes.includes("write_orders");
  const writeCustomers = grantedScopes.includes("write_customers");

  return (
    <s-stack gap="base">
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_intro")}
      </s-text>

      {!writeOrders && !writeCustomers ? (
        <Banner tone="info" heading={t("surveys.sync_no_scopes_title")}>
          {t("surveys.sync_no_scopes_body")}
        </Banner>
      ) : null}

      <s-text-field
        label={t("surveys.sync_order_tags")}
        value={tagText(raw.orderTags)}
        onInput={(e: Event) => set({ orderTags: parseTags(fieldValue(e)) })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_order_tags_help")}
      </s-text>

      <s-text-field
        label={t("surveys.sync_customer_tags")}
        value={tagText(raw.customerTags)}
        onInput={(e: Event) => set({ customerTags: parseTags(fieldValue(e)) })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_customer_tags_help")}
      </s-text>

      <s-checkbox
        name="sync-order-metafield"
        label={t("surveys.sync_metafield")}
        checked={Array.isArray(raw.metafields) && raw.metafields.length > 0 ? true : undefined}
        onChange={(e: Event) =>
          set({
            metafields: checkboxChecked(e)
              ? [{ namespace: "sourcetrac", key: "channel", type: "single_line_text_field" }]
              : [],
          })
        }
      />

      <s-checkbox
        name="sync-flow"
        label={t("surveys.sync_flow")}
        checked={raw.flowTrigger === true ? true : undefined}
        onChange={(e: Event) => set({ flowTrigger: checkboxChecked(e) })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_flow_help")}
      </s-text>
    </s-stack>
  );
}

function Translations({
  draft,
  update,
  languages,
  t,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  languages: Array<{ code: string; name: string }>;
  t: TFn;
}) {
  const [locale, setLocale] = useState(languages[0]?.code ?? "en");
  const translations = (draft.translations ?? {}) as Record<string, Record<string, unknown>>;
  const current = translations[locale] ?? {};

  const setLocaleText = (key: string, value: string) => {
    const next = { ...translations, [locale]: { ...current, [key]: value } };
    update({ translations: next });
  };

  const setQuestionText = (questionId: string, key: string, value: string) => {
    const questions = { ...((current.questions as Record<string, Record<string, string>>) ?? {}) };
    questions[questionId] = { ...(questions[questionId] ?? {}), [key]: value };
    const next = { ...translations, [locale]: { ...current, questions } };
    update({ translations: next });
  };

  return (
    <s-stack gap="base">
      <s-select label={t("surveys.translation_language")} value={locale} onChange={(e: Event) => setLocale(fieldValue(e))}>
        {languages.map((language) => (
          <s-option key={language.code} value={language.code}>
            {language.name}
          </s-option>
        ))}
      </s-select>
      <s-text color="subdued" fontSize="small">
        {t("surveys.translation_help")}
      </s-text>

      <s-text-field
        label={t("surveys.field_title")}
        value={String(current.title ?? "")}
        onInput={(e: Event) => setLocaleText("title", fieldValue(e))}
      />
      <s-text-field
        label={t("surveys.field_intro")}
        value={String(current.intro ?? "")}
        onInput={(e: Event) => setLocaleText("intro", fieldValue(e))}
      />
      <s-text-field
        label={t("surveys.field_button")}
        value={String(current.buttonLabel ?? "")}
        onInput={(e: Event) => setLocaleText("buttonLabel", fieldValue(e))}
      />
      <s-text-field
        label={t("surveys.field_thank_you")}
        value={String(current.thankYouText ?? "")}
        onInput={(e: Event) => setLocaleText("thankYouText", fieldValue(e))}
      />

      {draft.questions.map((question, index) => (
        <s-text-field
          key={question.id || `tq-${index}`}
          label={t("surveys.translation_question", { n: index + 1 })}
          value={String(
            ((current.questions as Record<string, Record<string, string>>) ?? {})[question.id]?.text ?? "",
          )}
          onInput={(e: Event) => setQuestionText(question.id, "text", fieldValue(e))}
        />
      ))}
    </s-stack>
  );
}

type SaveBarApi = {
  show: (id: string) => void;
  hide: (id: string) => void;
};
