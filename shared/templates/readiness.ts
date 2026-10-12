/**
 * Survey change summary (S8) and ready check (S9).
 *
 * Pure functions over two survey definitions. `diffSurvey` produces a list of
 * typed, localized change records; the caller renders them. `getReadiness`
 * returns the checklist state. Both are unit-tested against every case.
 *
 * Dependency-free so the tests run in plain Node.
 */

import { LIMITS, validateSurveyDefinition, type SurveyDefinition } from "../survey-rules";

/** One plain-language change between two survey definitions. */
export type SurveyChange =
  | { kind: "question_text"; questionIndex: number }
  | { kind: "question_added"; questionIndex: number }
  | { kind: "question_removed"; questionIndex: number; hasAnswers: boolean }
  | { kind: "option_added"; questionIndex: number; label: string }
  | { kind: "option_removed"; questionIndex: number; label: string; hasAnswers: boolean }
  | { kind: "option_label"; questionIndex: number; label: string }
  | { kind: "placement_added"; placement: string }
  | { kind: "placement_removed"; placement: string }
  | { kind: "audience"; audience: string }
  | { kind: "design"; field: string; value: string }
  | { kind: "title" }
  | { kind: "intro" }
  | { kind: "button" }
  | { kind: "thankyou" }
  | { kind: "targeting" };

export type DiffInput = {
  questions: Array<{ id: string; text: string; options?: Array<{ id: string; label: string }> }>;
  placements?: string[];
  title?: string;
  intro?: string | null;
  buttonLabel?: string;
  thankYouText?: string;
  audience?: string;
  design?: Record<string, unknown>;
};

/**
 * Compare the published definition with a draft.
 *
 * Removed questions/options that still hold answers are flagged, so the UI can
 * add "Removed items keep their past answers in Results."
 */
export function diffSurvey(
  published: DiffInput,
  draft: DiffInput,
  hasAnswers: (questionId: string, optionId: string | null) => boolean = () => false,
): SurveyChange[] {
  const changes: SurveyChange[] = [];

  if (published.title !== draft.title) changes.push({ kind: "title" });
  if ((published.intro ?? "") !== (draft.intro ?? "")) changes.push({ kind: "intro" });
  if (published.buttonLabel !== draft.buttonLabel) changes.push({ kind: "button" });
  if (published.thankYouText !== draft.thankYouText) changes.push({ kind: "thankyou" });

  // Placements.
  const pubPlacements = new Set(published.placements ?? []);
  const draftPlacements = new Set(draft.placements ?? []);
  for (const p of draftPlacements) if (!pubPlacements.has(p)) changes.push({ kind: "placement_added", placement: p });
  for (const p of pubPlacements) if (!draftPlacements.has(p)) changes.push({ kind: "placement_removed", placement: p });

  // Audience.
  if ((published.audience ?? "everyone") !== (draft.audience ?? "everyone")) {
    changes.push({ kind: "audience", audience: draft.audience ?? "everyone" });
  }

  // Design.
  const fields = new Set([...Object.keys(published.design ?? {}), ...Object.keys(draft.design ?? {})]);
  for (const field of fields) {
    if ((published.design ?? {})[field] !== (draft.design ?? {})[field]) {
      changes.push({ kind: "design", field, value: String((draft.design ?? {})[field] ?? "") });
    }
  }

  // Questions and their options.
  const pubById = new Map(published.questions.map((q) => [q.id, q]));
  const draftIds = new Set(draft.questions.map((q) => q.id));

  draft.questions.forEach((question, index) => {
    const before = question.id ? pubById.get(question.id) : undefined;
    if (!before) {
      changes.push({ kind: "question_added", questionIndex: index });
      return;
    }
    if (before.text !== question.text) {
      changes.push({ kind: "question_text", questionIndex: index });
    }
    const beforeOptions = new Map((before.options ?? []).map((o) => [o.id, o]));
    const afterOptions = new Map((question.options ?? []).map((o) => [o.id, o]));
    for (const [id, option] of afterOptions) {
      if (!beforeOptions.has(id)) {
        changes.push({ kind: "option_added", questionIndex: index, label: option.label });
      } else if (beforeOptions.get(id)!.label !== option.label) {
        changes.push({ kind: "option_label", questionIndex: index, label: option.label });
      }
    }
    for (const [id, option] of beforeOptions) {
      if (!afterOptions.has(id)) {
        changes.push({
          kind: "option_removed",
          questionIndex: index,
          label: option.label,
          hasAnswers: hasAnswers(question.id, id),
        });
      }
    }
  });

  published.questions.forEach((question, index) => {
    if (!draftIds.has(question.id)) {
      changes.push({
        kind: "question_removed",
        questionIndex: index,
        hasAnswers: hasAnswers(question.id, null),
      });
    }
  });

  return changes;
}

/** Whether any removed item still has answers, so the note should be shown. */
export function diffHasRemovedWithAnswers(changes: readonly SurveyChange[]): boolean {
  return changes.some(
    (c) =>
      (c.kind === "question_removed" || c.kind === "option_removed") && c.hasAnswers,
  );
}

// ---------------------------------------------------------------------------
// Ready check (S9)
// ---------------------------------------------------------------------------

export type ReadinessCheckId =
  | "has_questions"
  | "valid_questions"
  | "has_placement"
  | "fits_plan"
  | "config_size"
  | "block_added"
  | "translations"
  | "question_count_tip";

export type ReadinessItem = {
  id: ReadinessCheckId;
  ok: boolean;
  /** Blocking items must pass before Go live is enabled. */
  blocking: boolean;
  /** Optional link target key the UI turns into a jump. */
  fix?: string;
};

export type ReadinessInput = {
  definition: SurveyDefinition;
  placements: string[];
  /** Question count allowed on the current plan, or null for unlimited. */
  maxQuestions: number | null;
  /** Whether the active-survey limit is already reached (draft is fine either way). */
  overActiveLimit: boolean;
  /** Compiled config size in bytes, if known. */
  configBytes?: number;
  /** Per selected page, whether the checkout block is known to be placed. */
  blockAdded?: boolean | null;
  /** Whether translations are complete for the shop's in-scope languages. */
  translationsComplete?: boolean | null;
};

/**
 * The ready check. Blocking items gate Go live; the rest are warnings or tips.
 */
export function getReadiness(input: ReadinessInput): ReadinessItem[] {
  const errors = validateSurveyDefinition(input.definition);
  const questionCount = input.definition.questions.length;

  const items: ReadinessItem[] = [
    { id: "has_questions", ok: questionCount > 0, blocking: true, fix: "questions" },
    {
      id: "valid_questions",
      ok: errors.length === 0,
      blocking: true,
      fix: errors[0]?.path,
    },
    { id: "has_placement", ok: input.placements.length > 0, blocking: true, fix: "placements" },
    {
      id: "fits_plan",
      ok: (input.maxQuestions === null || questionCount <= input.maxQuestions) && !input.overActiveLimit,
      blocking: true,
      fix: "fits_plan",
    },
    {
      id: "config_size",
      ok: input.configBytes === undefined || input.configBytes <= LIMITS.MAX_COMPILED_CONFIG_BYTES,
      blocking: true,
      fix: "config_size",
    },
    {
      id: "block_added",
      // null means "not known": do not block, and do not warn.
      ok: input.blockAdded !== false,
      blocking: false,
      fix: "block_added",
    },
    {
      id: "translations",
      ok: input.translationsComplete !== false,
      blocking: false,
      fix: "translations",
    },
    {
      id: "question_count_tip",
      ok: questionCount <= LIMITS.RECOMMENDED_MAX_QUESTIONS,
      blocking: false,
      fix: "questions",
    },
  ];

  return items;
}

/** Whether every blocking check passes. */
export function readinessBlocksGoLive(items: readonly ReadinessItem[]): boolean {
  return items.some((item) => item.blocking && !item.ok);
}
