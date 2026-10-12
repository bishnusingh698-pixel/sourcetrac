import { useMemo, useState } from "react";

import { buildLogicTree, type LogicNode } from "@shared/logic-tree";
import { isQuestionVisible, type AnswerInput } from "@shared/survey-rules";
import type { EditorSurvey } from "~/lib/surveys.server";
import type { useAdminI18n } from "~/lib/i18n/use-admin-i18n";

type TFn = ReturnType<typeof useAdminI18n>["t"];

type Draft = EditorSurvey;

/**
 * The Logic map — a merchant-facing view of the survey's show-if tree.
 *
 * It renders `buildLogicTree(draft)` (a pure function, unit tested) and lets the
 * merchant add, edit and remove rules through the same shared validation and the
 * same dirty-state save bar as the Questions view. Nothing here duplicates the
 * visibility rule: the "Try it as a shopper" panel calls `isQuestionVisible`
 * from the shared rules.
 */

/** The type badge key for a question type. */
const TYPE_KEY: Record<string, string> = {
  single_choice: "logic.badge_single",
  multi_choice: "logic.badge_multi",
  dropdown: "logic.badge_dropdown",
  yes_no: "logic.badge_yesno",
  rating_5: "logic.badge_rating",
  satisfaction_5: "logic.badge_satisfaction",
  nps_0_10: "logic.badge_nps",
  text: "logic.badge_text",
};

export function LogicMap({
  draft,
  update,
  t,
  maxQuestions,
  canUseLogic,
  onEditQuestion,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  t: TFn;
  maxQuestions: number;
  canUseLogic: boolean;
  onEditQuestion: (questionId: string) => void;
}) {
  const tree = useMemo(() => buildLogicTree(toDefinition(draft)), [draft]);
  const [modal, setModal] = useState<{ parentId: string; editId: string | null } | null>(null);

  return (
    <s-stack gap="base">
      <s-banner tone="info" heading={t("logic.title")}>
        {t("logic.intro")}
      </s-banner>

      {tree.warnings.some((w) => w.code === "long_survey") ? (
        <s-text color="subdued" fontSize="small">
          {t("logic.warn_long_survey", { count: draft.questions.length })}
        </s-text>
      ) : null}

      {tree.roots.length === 0 ? (
        <s-text color="subdued">{t("logic.empty")}</s-text>
      ) : (
        <s-stack gap="small">
          {tree.roots.map((root) => (
            <NodeCard
              key={root.questionId}
              node={root}
              t={t}
              canUseLogic={canUseLogic}
              full={draft.questions.length >= maxQuestions}
              onAddFollowUp={(parentId) => setModal({ parentId, editId: null })}
              onEditRule={(questionId) => setModal({
                parentId: draft.questions.find((q) => q.id === questionId)?.showIf?.questionId ?? "",
                editId: questionId,
              })}
              onRemoveRule={(questionId) => {
                update({ questions: draft.questions.map((q) => (q.id === questionId ? { ...q, showIf: null } : q)) });
              }}
              onEditQuestion={onEditQuestion}
            />
          ))}
        </s-stack>
      )}

      {canUseLogic ? (
        <TryPath draft={draft} t={t} />
      ) : (
        <s-banner tone="warning" heading={t("logic.gated_title")}>
          {t("logic.gated_body")}
        </s-banner>
      )}

      {modal ? (
        <FollowUpModal
          draft={draft}
          update={update}
          t={t}
          parentId={modal.parentId}
          editId={modal.editId}
          maxQuestions={maxQuestions}
          onClose={() => setModal(null)}
        />
      ) : null}
    </s-stack>
  );
}

function NodeCard({
  node,
  t,
  canUseLogic,
  full,
  onAddFollowUp,
  onEditRule,
  onRemoveRule,
  onEditQuestion,
}: {
  node: LogicNode;
  t: TFn;
  canUseLogic: boolean;
  full: boolean;
  onAddFollowUp: (parentId: string) => void;
  onEditRule: (questionId: string) => void;
  onRemoveRule: (questionId: string) => void;
  onEditQuestion: (questionId: string) => void;
}) {
  const conditionLabel = conditionText(node, t);
  const aria = node.always
    ? t("logic.aria_node_always", { n: node.index })
    : t("logic.aria_node", { n: node.index, condition: conditionLabel });

  const canBranch = ["single_choice", "multi_choice", "dropdown", "yes_no", "rating_5", "satisfaction_5", "nps_0_10"].includes(node.type);

  return (
    <s-box padding="small" border="base" borderRadius="base">
      <s-stack gap="small">
        <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text type="strong">{t("logic.question_number", { n: node.index })}</s-text>
            <s-badge tone="neutral">{t(TYPE_KEY[node.type] ?? "logic.badge_single")}</s-badge>
            <s-badge tone={node.required ? "warning" : "neutral"}>
              {node.required ? t("logic.required") : t("logic.optional")}
            </s-badge>
          </s-stack>
        </s-stack>

        <s-text aria-label={aria}>{node.text}</s-text>

        <s-text color="subdued" fontSize="small">
          {node.always ? t("logic.everyone") : conditionLabel}
        </s-text>

        {node.depth > 1 ? (
          <s-text color="subdued" fontSize="small">
            {t("logic.depends_on", { n: node.index })}
          </s-text>
        ) : null}

        {node.warnings.map((warning) => (
          <s-banner key={warning.code} tone="warning">
            {t(`logic.warn_${warning.code}`)}
          </s-banner>
        ))}

        <s-stack direction="inline" gap="small">
          {canBranch && canUseLogic ? (
            <s-button
              variant="secondary"
              disabled={full || undefined}
              onClick={() => onAddFollowUp(node.questionId)}
            >
              {t("logic.add_follow_up")}
            </s-button>
          ) : null}
          {!node.always && canUseLogic ? (
            <>
              <s-button variant="secondary" onClick={() => onEditRule(node.questionId)}>
                {t("logic.edit_rule")}
              </s-button>
              <s-button variant="secondary" tone="critical" onClick={() => onRemoveRule(node.questionId)}>
                {t("logic.remove_rule")}
              </s-button>
            </>
          ) : null}
          <s-button variant="secondary" onClick={() => onEditQuestion(node.questionId)}>
            {t("logic.edit_question")}
          </s-button>
        </s-stack>

        {node.children.length > 0 ? (
          <s-stack gap="small">
            {node.children.map((child) => (
              <NodeCard
                key={child.questionId}
                node={child}
                t={t}
                canUseLogic={canUseLogic}
                full={full}
                onAddFollowUp={onAddFollowUp}
                onEditRule={onEditRule}
                onRemoveRule={onRemoveRule}
                onEditQuestion={onEditQuestion}
              />
            ))}
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}

/** Localised branch label from the structured condition. */
function conditionText(node: LogicNode, t: TFn): string {
  const cond = node.condition;
  if (!cond || cond.kind === "always") return t("logic.everyone");
  if (cond.kind === "empty") return t("logic.if_any");
  if (cond.kind === "range") {
    if (typeof cond.min === "number" && typeof cond.max === "number") {
      return t("logic.if_range_both", { min: cond.min, max: cond.max });
    }
    if (typeof cond.min === "number") return t("logic.if_range_min", { min: cond.min });
    return t("logic.if_range_max", { max: cond.max });
  }
  const labels = cond.labels;
  if (labels.length === 1) return t("logic.if_answer_one", { option: labels[0] ?? "" });
  return t("logic.if_answer_options", { options: labels.join(", ") });
}

function FollowUpModal({
  draft,
  update,
  t,
  parentId,
  editId,
  maxQuestions,
  onClose,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  t: TFn;
  parentId: string;
  editId: string | null;
  maxQuestions: number;
  onClose: () => void;
}) {
  const editing = editId ? draft.questions.find((q) => q.id === editId) ?? null : null;
  const [parent, setParent] = useState(parentId || editing?.showIf?.questionId || "");
  const [selected, setSelected] = useState<string[]>(editing?.showIf?.optionIds ?? []);
  const [min, setMin] = useState<number | null>(editing?.showIf?.min ?? null);
  const [max, setMax] = useState<number | null>(editing?.showIf?.max ?? null);
  const [text, setText] = useState(editing?.text ?? "");
  const [type, setType] = useState(editing?.type ?? "text");

  const parentQuestion = draft.questions.find((q) => q.id === parent);
  const numeric = parentQuestion ? ["rating_5", "nps_0_10", "satisfaction_5"].includes(parentQuestion.type) : false;
  const optionList = parentQuestion && !numeric ? optionsFor(parentQuestion) : [];

  const save = () => {
    const showIf = numeric
      ? { questionId: parent, min: min ?? undefined, max: max ?? undefined }
      : { questionId: parent, optionIds: selected };
    if (editing) {
      update({
        questions: draft.questions.map((q) =>
          q.id === editing.id ? { ...q, text: text || q.text, showIf } : q,
        ),
      });
    } else {
      const parentIndex = draft.questions.findIndex((q) => q.id === parent);
      const newQuestion = {
        id: "",
        type: type as Draft["questions"][number]["type"],
        text: text || t("logic.new_question_text"),
        required: false,
        options: [],
        showIf,
      };
      const next = [...draft.questions];
      next.splice(parentIndex + 1, 0, newQuestion as Draft["questions"][number]);
      update({ questions: next });
    }
    onClose();
  };

  const canSave = parent !== "" && (numeric ? min !== null || max !== null : selected.length > 0);

  return (
    <s-section
      heading={editing ? t("logic.modal_heading_edit") : t("logic.modal_heading_add")}
      padding="none"
    >
      <s-box padding="small" border="base" borderRadius="base">
        <s-stack gap="base">
          <s-select
            label={t("logic.modal_parent")}
            value={parent}
            onChange={(e: Event) => {
              setParent(value(e));
              setSelected([]);
              setMin(null);
              setMax(null);
            }}
          >
            <s-option value="">{t("logic.modal_pick_parent")}</s-option>
            {draft.questions
              .slice(0, editing ? draft.questions.findIndex((q) => q.id === editing.id) : draft.questions.length)
              .filter((q) => ["single_choice", "multi_choice", "dropdown", "yes_no", "rating_5", "satisfaction_5", "nps_0_10"].includes(q.type))
              .map((q, i) => (
                <s-option key={q.id || `p-${i}`} value={q.id || `p-${i}`}>
                  {q.text || t("logic.question_number", { n: draft.questions.indexOf(q) + 1 })}
                </s-option>
              ))}
          </s-select>

          {parentQuestion ? (
            numeric ? (
              <s-stack direction="inline" gap="small">
                <NumberInput label={t("surveys.show_if_min")} value={min} onChange={setMin} />
                <NumberInput label={t("surveys.show_if_max")} value={max} onChange={setMax} />
              </s-stack>
            ) : (
              <s-stack gap="small">
                <s-text>{t("logic.modal_when")}</s-text>
                {optionList.map((option, i) => (
                  <s-checkbox
                    key={option.id || `o-${i}`}
                    label={option.label}
                    checked={selected.includes(option.id) || undefined}
                    onChange={(e: Event) => {
                      const set = new Set(selected);
                      if (checked(e)) set.add(option.id);
                      else set.delete(option.id);
                      setSelected([...set]);
                    }}
                  />
                ))}
              </s-stack>
            )
          ) : null}

          {!editing ? (
            <s-select label={t("logic.modal_type")} value={type} onChange={(e: Event) => setType(value(e) as typeof type)}>
              <s-option value="text">{t("surveys.type_text")}</s-option>
              <s-option value="single_choice">{t("surveys.type_single")}</s-option>
              <s-option value="multi_choice">{t("surveys.type_multi")}</s-option>
              <s-option value="rating_5">{t("surveys.type_rating")}</s-option>
              <s-option value="nps_0_10">{t("surveys.type_nps")}</s-option>
              <s-option value="yes_no">{t("surveys.type_yesno")}</s-option>
            </s-select>
          ) : null}

          <s-text-field
            label={t("logic.modal_text")}
            value={text}
            maxLength={200}
            onInput={(e: Event) => setText(value(e))}
          />

          <s-stack direction="inline" gap="small">
            <s-button variant="primary" disabled={!canSave || undefined} onClick={save}>
              {editing ? t("logic.modal_save") : t("logic.modal_add")}
            </s-button>
            <s-button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </s-button>
          </s-stack>
        </s-stack>
      </s-box>
    </s-section>
  );
}

function TryPath({ draft, t }: { draft: Draft; t: TFn }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const visibility = useMemo(() => computeVisibility(draft, answers), [draft, answers]);

  return (
    <s-section heading={t("logic.try_title")} subheading={t("logic.try_help")} padding="none">
      <s-stack gap="small">
        {draft.questions.map((q, i) => {
          const visible = visibility.get(q.id) ?? true;
          return (
            <s-stack key={q.id || `q-${i}`} gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone={visible ? "success" : "neutral"}>
                  {visible ? t("logic.try_shown") : t("logic.try_skipped")}
                </s-badge>
                <s-text>{q.text || t("logic.question_number", { n: i + 1 })}</s-text>
              </s-stack>
              <s-select
                label={t("logic.try_answer")}
                value={answers[q.id] ?? ""}
                onChange={(e: Event) => setAnswers((prev) => ({ ...prev, [q.id]: value(e) }))}
              >
                <s-option value="">{t("logic.try_none")}</s-option>
                {optionsFor(q).map((o, oi) => (
                  <s-option key={o.id || `s-${oi}`} value={o.id}>
                    {o.label}
                  </s-option>
                ))}
              </s-select>
            </s-stack>
          );
        })}
      </s-stack>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function value(event: Event): string {
  return (event.target as { value?: string } | null)?.value ?? "";
}
function checked(event: Event): boolean {
  return (event.target as { checked?: boolean } | null)?.checked ?? false;
}

/** Convert the editor draft into a `SurveyDefinition` the shared rules accept. */
function toDefinition(draft: Draft) {
  return {
    questions: draft.questions.map((q, i) => ({
      id: q.id || `unsaved-${i}`,
      type: q.type,
      text: q.text,
      required: q.required,
      showIf: q.showIf ?? null,
      options: (q.options ?? []).map((o) => ({ id: o.id || `opt-${i}-${o.label}`, label: o.label, archived: o.archived })),
    })),
  };
}

/** Options a condition on `question` can reference (fixed options for score types). */
function optionsFor(question: Draft["questions"][number]): Array<{ id: string; label: string }> {
  if (question.type === "yes_no") return [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
  if (question.type === "satisfaction_5") {
    return [
      { id: "very_dissatisfied", label: "Very dissatisfied" },
      { id: "dissatisfied", label: "Dissatisfied" },
      { id: "neutral", label: "Neutral" },
      { id: "satisfied", label: "Satisfied" },
      { id: "very_satisfied", label: "Very satisfied" },
    ];
  }
  return (question.options ?? []).map((o) => ({ id: o.id, label: o.label }));
}

/**
 * Which questions a shopper would see for a set of answers. Delegates to the
 * shared `isQuestionVisible` so the simulator can never disagree with the
 * server: only answers to questions that are themselves visible are fed in,
 * exactly as the extension and the submit validation do.
 */
function computeVisibility(draft: Draft, answers: Record<string, string>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const definition = toDefinition(draft);
  const visibleAnswers: AnswerInput[] = [];
  for (const question of definition.questions) {
    const visible = isQuestionVisible(question, visibleAnswers);
    out.set(question.id, visible);
    const raw = answers[question.id];
    if (visible && raw !== undefined && raw !== "") {
      const numeric = Number(raw);
      visibleAnswers.push({
        questionId: question.id,
        optionIds: [raw],
        numberValue: Number.isNaN(numeric) ? null : numeric,
      });
    }
  }
  return out;
}

function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <s-number-field
      label={label}
      value={value === null ? "" : String(value)}
      onInput={(e: Event) => {
        const raw = valueOf(e);
        onChange(raw === "" ? null : Number(raw));
      }}
    />
  );
}

function valueOf(event: Event): string {
  return (event.target as { value?: string } | null)?.value ?? "";
}
