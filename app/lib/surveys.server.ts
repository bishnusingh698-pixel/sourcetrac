/**
 * Survey repository and config compiler.
 *
 * Owns the Survey / Question / Option tables and turns them into:
 *   - an editor payload (everything the admin UI needs), and
 *   - a compiled config (exactly what the checkout extension reads).
 *
 * The compiled config is cached in memory per shop. A shopper *seeing* a survey
 * costs zero database queries; only a submission writes. The cache is empty
 * after a Render restart, so the first read after a cold start does one query.
 */

import { Prisma, type SurveyStatus } from "@prisma/client";

import { db } from "~/db.server";
import { ConflictError, NotFoundError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import {
  DEFAULT_SURVEY_TEXT,
  type CompiledConfig,
  type CompiledQuestion,
  type CompiledSurvey,
  type Placement,
  type Targeting,
} from "@shared/survey-config";
import {
  DEFAULT_DESIGN,
  LIMITS,
  resolveDesign,
  validateSurveyDefinition,
  type DesignSettings,
  type ShowIf,
  type SurveyDefinition,
  type SurveyOptionDef,
  type SurveyQuestionDef,
} from "@shared/survey-rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditorOption = {
  id: string;
  label: string;
  isOther: boolean;
  /** T6: clears other selections in multiple choice. */
  exclusive: boolean;
  archived: boolean;
  translations: Record<string, string | undefined>;
};

export type EditorQuestion = Omit<SurveyQuestionDef, "options"> & {
  options: EditorOption[];
};

export type EditorSurvey = {
  id: string;
  name: string;
  status: SurveyStatus;
  priority: number;
  placements: Placement[];
  layout: "all" | "one_by_one";
  title: string;
  intro: string | null;
  buttonLabel: string;
  thankYouText: string;
  channelReportQuestionId: string | null;
  targeting: Targeting;
  syncOptions: Record<string, unknown>;
  translations: Record<string, unknown>;
  version: number;
  responseCount: number;
  /** Template provenance, for display only. */
  templateId: string | null;
  templateVersion: number | null;
  /** T11. */
  rotation: boolean;
  rotationWeight: number;
  /** T10. */
  learnAndStop: boolean;
  /** S11/S12. */
  design: DesignSettings;
  /** ISO instant of the last draft save, or null when there is no draft. */
  draftUpdatedAt: string | null;
  /** True when an unpublished draft exists (live/paused surveys only). */
  hasDraft: boolean;
  /**
   * Optimistic-concurrency token (section 6.6). The editor posts it back on save
   * and publish; a mismatch means another window changed the survey.
   */
  revision: number;
  questions: EditorQuestion[];
  updatedAt: string;
};

export type SurveyListItem = {
  id: string;
  name: string;
  status: SurveyStatus;
  priority: number;
  placements: Placement[];
  questionCount: number;
  responseCount: number;
  updatedAt: string;
};

/** Shape the editor posts back. Option ids are optional: absent means "new". */
export type SurveyInputQuestion = Omit<SurveyQuestionDef, "id" | "options"> & {
  id?: string;
  options?: Array<Omit<SurveyOptionDef, "id"> & { id?: string }>;
};

export type SurveyInput = {
  name: string;
  status?: SurveyStatus;
  priority?: number;
  placements: Placement[];
  layout: "all" | "one_by_one";
  title: string;
  intro: string | null;
  buttonLabel: string;
  thankYouText: string;
  channelReportQuestionId?: string | null;
  targeting?: Targeting;
  syncOptions?: Record<string, unknown>;
  translations?: Record<string, unknown>;
  templateId?: string | null;
  templateVersion?: number | null;
  rotation?: boolean;
  rotationWeight?: number;
  learnAndStop?: boolean;
  design?: Partial<DesignSettings>;
  questions: SurveyInputQuestion[];
};

const surveyInclude = {
  questions: {
    orderBy: { position: "asc" as const },
    include: { options: { orderBy: { position: "asc" as const } } },
  },
} satisfies Prisma.SurveyInclude;

type SurveyWithQuestions = Prisma.SurveyGetPayload<{ include: typeof surveyInclude }>;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToEditor(row: SurveyWithQuestions): EditorSurvey {
  const published: EditorSurvey = {
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    placements: parseJson<Placement[]>(row.placements, []),
    layout: row.layout,
    title: row.title ?? DEFAULT_SURVEY_TEXT.title,
    intro: row.intro,
    buttonLabel: row.buttonLabel ?? DEFAULT_SURVEY_TEXT.buttonLabel,
    thankYouText: row.thankYouText ?? DEFAULT_SURVEY_TEXT.thankYouText,
    channelReportQuestionId: row.channelReportQuestionId,
    targeting: parseJson<Targeting>(row.targeting, {}),
    syncOptions: parseJson<Record<string, unknown>>(row.syncOptions, {}),
    translations: parseJson<Record<string, unknown>>(row.translations, {}),
    version: row.version,
    responseCount: row.responseCount,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    rotation: row.rotation,
    rotationWeight: row.rotationWeight,
    learnAndStop: row.learnAndStop,
    design: resolveDesign(parseJson<Partial<DesignSettings>>(row.designJson, {})),
    draftUpdatedAt: row.draftUpdatedAt ? row.draftUpdatedAt.toISOString() : null,
    hasDraft: row.draft !== null,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    questions: row.questions.map(toEditorQuestion),
  };

  // A live/paused survey with unpublished changes shows the DRAFT in the
  // editor, so the merchant keeps editing their latest work. Overview and
  // Results read the published structure instead (section 6.6); this is only
  // the Studio's view.
  if (row.draft) {
    const draft = parseJson<SurveyInput | null>(row.draft, null);
    if (draft) {
      return {
        ...published,
        name: draft.name ?? published.name,
        placements: draft.placements ?? published.placements,
        layout: draft.layout ?? published.layout,
        title: draft.title ?? published.title,
        intro: draft.intro ?? published.intro,
        buttonLabel: draft.buttonLabel ?? published.buttonLabel,
        thankYouText: draft.thankYouText ?? published.thankYouText,
        channelReportQuestionId: draft.channelReportQuestionId ?? published.channelReportQuestionId,
        targeting: draft.targeting ?? published.targeting,
        syncOptions: draft.syncOptions ?? published.syncOptions,
        translations: draft.translations ?? published.translations,
        rotation: draft.rotation ?? published.rotation,
        rotationWeight: draft.rotationWeight ?? published.rotationWeight,
        learnAndStop: draft.learnAndStop ?? published.learnAndStop,
        design: draft.design ? resolveDesign(draft.design) : published.design,
        // Draft questions/options carry no database ids, so a new item shows as
        // new until publish. Kept ids survive and stay matched on publish.
        questions: (draft.questions ?? []).map((question, index) => ({
          ...question,
          id: question.id ?? `draft-q${index}`,
          textMultiline: question.textMultiline ?? false,
          required: question.required ?? false,
          randomizeOptions: question.randomizeOptions ?? false,
          allowOther: question.allowOther ?? false,
          minSelections: question.minSelections ?? null,
          maxSelections: question.maxSelections ?? null,
          showIf: question.showIf ?? null,
          translations: question.translations ?? {},
          archived: false,
          options: (question.options ?? []).map((option) => ({
            ...option,
            id: option.id ?? "",
            isOther: option.isOther ?? false,
            exclusive: option.exclusive ?? false,
            archived: false,
            translations: option.translations ?? {},
          })),
        })),
      };
    }
  }

  return published;
}

function toEditorQuestion(question: SurveyWithQuestions["questions"][number]): EditorQuestion {
  return {
    id: question.id,
    type: question.type,
    text: question.text,
    helpText: question.helpText,
    placeholder: question.placeholder,
    textMultiline: question.textMultiline,
    required: question.required,
    randomizeOptions: question.randomizeOptions,
    allowOther: question.allowOther,
    minSelections: question.minSelections,
    maxSelections: question.maxSelections,
    showIf: parseJson<ShowIf | null>(question.showIf, null),
    translations: parseJson(question.translations, {}),
    archived: question.archived,
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      isOther: option.isOther,
      exclusive: option.exclusive,
      archived: option.archived,
      translations: parseJson(option.translations, {}),
    })),
  };
}

function editorToDefinition(survey: EditorSurvey): SurveyDefinition {
  return {
    id: survey.id,
    name: survey.name,
    title: survey.title,
    intro: survey.intro,
    buttonLabel: survey.buttonLabel,
    thankYouText: survey.thankYouText,
    layout: survey.layout,
    questions: survey.questions,
  };
}

/** Validate an editor survey with the shared rules, throwing on the first issue. */
export function assertValid(survey: SurveyDefinition): void {
  const issues = validateSurveyDefinition(survey);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new ValidationError(first.message, "Check the highlighted field and save again.", {
      field: first.path,
      code: first.code,
      issues,
    });
  }
}

/**
 * Turn editor input into a `SurveyDefinition` for the shared validator, which
 * requires an `id` on every question and option. New rows have no id yet, so a
 * stable placeholder is used for validation only — it is never persisted.
 */
function inputToDefinition(input: SurveyInput, id?: string): SurveyDefinition {
  return {
    id,
    name: input.name,
    title: input.title,
    intro: input.intro,
    buttonLabel: input.buttonLabel,
    thankYouText: input.thankYouText,
    layout: input.layout,
    questions: input.questions.map((question, index) => ({
      ...question,
      id: question.id ?? `new-q${index}`,
      options: question.options?.map((option, optionIndex) => ({
        ...option,
        id: option.id ?? `new-o${index}-${optionIndex}`,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSurveys(shopId: string): Promise<SurveyListItem[]> {
  const rows = await db.survey.findMany({
    where: { shopId },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    include: { _count: { select: { questions: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    placements: parseJson<Placement[]>(row.placements, []),
    questionCount: row._count.questions,
    responseCount: row.responseCount,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getSurveyRow(shopId: string, surveyId: string): Promise<SurveyWithQuestions | null> {
  return db.survey.findFirst({ where: { id: surveyId, shopId }, include: surveyInclude });
}

/**
 * Guard an optimistic-concurrency write (section 6.6).
 *
 * The editor sends the `revision` it loaded; if the stored row has moved on, a
 * different window changed the survey and this write is refused so the merchant
 * reloads instead of silently clobbering the other edit. `undefined` means the
 * caller is not tracking a revision (older clients, tests) and the check is
 * skipped.
 */
function assertRevision(expected: number | undefined, actual: number): void {
  if (expected === undefined) return;
  if (expected !== actual) throw new ConflictError(undefined, { expected, actual });
}

export async function getEditorSurvey(shopId: string, surveyId: string): Promise<EditorSurvey> {
  const row = await getSurveyRow(shopId, surveyId);
  if (!row) throw new NotFoundError("That survey does not exist.", { surveyId });
  return rowToEditor(row);
}

export async function getActiveSurveys(shopId: string): Promise<SurveyWithQuestions[]> {
  return db.survey.findMany({
    where: { shopId, status: "active" },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    include: surveyInclude,
  });
}

export async function countSurveys(shopId: string): Promise<{ total: number; active: number }> {
  const [total, active] = await Promise.all([
    db.survey.count({ where: { shopId } }),
    db.survey.count({ where: { shopId, status: "active" } }),
  ]);
  return { total, active };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function persistQuestions(
  tx: Prisma.TransactionClient,
  surveyId: string,
  questions: SurveyInput["questions"],
  { hasResponses }: { hasResponses: boolean },
): Promise<string | null> {
  // Existing option ids for this survey, so a posted id can be matched.
  const existingOptions = await tx.option.findMany({
    where: { question: { surveyId } },
    select: { id: true, questionId: true },
  });
  const existingIds = new Set(existingOptions.map((o) => o.id));

  const keptOptionIds = new Set<string>();
  const keptQuestionIds = new Set<string>();

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!;
    const questionId =
      question.id && (await tx.question.findFirst({ where: { id: question.id, surveyId }, select: { id: true } }))
        ? question.id
        : undefined;

    const data = {
      position: i,
      type: question.type,
      text: question.text,
      helpText: question.helpText ?? null,
      placeholder: question.placeholder ?? null,
      textMultiline: question.textMultiline ?? false,
      required: question.required ?? false,
      randomizeOptions: question.randomizeOptions ?? false,
      allowOther: question.allowOther ?? false,
      minSelections: question.minSelections ?? null,
      maxSelections: question.maxSelections ?? null,
      showIf: question.showIf ? JSON.stringify(question.showIf) : null,
      translations: JSON.stringify(question.translations ?? {}),
      archived: false,
    };

    let savedQuestionId: string;
    if (questionId) {
      await tx.question.update({ where: { id: questionId }, data });
      savedQuestionId = questionId;
    } else {
      const created = await tx.question.create({ data: { ...data, surveyId }, select: { id: true } });
      savedQuestionId = created.id;
    }
    keptQuestionIds.add(savedQuestionId);

    const options = question.options ?? [];
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      const optionId = option.id && existingIds.has(option.id) ? option.id : undefined;
      const optionData = {
        position: j,
        label: option.label,
        isOther: option.isOther ?? false,
        exclusive: option.exclusive ?? false,
        archived: false,
        translations: JSON.stringify(option.translations ?? {}),
      };
      if (optionId) {
        await tx.option.update({ where: { id: optionId }, data: optionData });
        keptOptionIds.add(optionId);
      } else {
        const created = await tx.option.create({
          data: { ...optionData, questionId: savedQuestionId },
          select: { id: true },
        });
        keptOptionIds.add(created.id);
      }
    }
  }

  // Removed questions and options: delete when the survey has no answers yet
  // (nothing to lose), otherwise archive so results keep their labels.
  const removedQuestions = await tx.question.findMany({
    where: { surveyId, id: { notIn: [...keptQuestionIds] } },
    select: { id: true },
  });
  const removedOptions = await tx.option.findMany({
    where: { question: { surveyId }, id: { notIn: [...keptOptionIds] } },
    select: { id: true },
  });

  if (hasResponses) {
    if (removedOptions.length > 0) {
      await tx.option.updateMany({ where: { id: { in: removedOptions.map((o) => o.id) } }, data: { archived: true } });
    }
    if (removedQuestions.length > 0) {
      await tx.question.updateMany({
        where: { id: { in: removedQuestions.map((q) => q.id) } },
        data: { archived: true },
      });
    }
  } else {
    // No answers: a hard delete is safe and keeps a draft clean.
    await tx.option.deleteMany({ where: { id: { in: removedOptions.map((o) => o.id) } } });
    await tx.question.deleteMany({ where: { id: { in: removedQuestions.map((q) => q.id) } } });
  }

  return questions[0]?.id ?? null;
}

export async function createSurvey(shopId: string, input: SurveyInput): Promise<EditorSurvey> {
  const { total } = await countSurveys(shopId);
  if (total >= LIMITS.MAX_SURVEYS_TOTAL) {
    throw new ValidationError(
      `You can have at most ${LIMITS.MAX_SURVEYS_TOTAL} surveys.`,
      "Delete a survey you no longer need, then try again.",
      { field: "name", code: "too_many_surveys" },
    );
  }

  assertValid(inputToDefinition(input));

  const created = await db.$transaction(async (tx) => {
    const survey = await tx.survey.create({
      data: {
        shopId,
        name: input.name,
        status: input.status ?? "draft",
        priority: input.priority ?? 0,
        placements: JSON.stringify(input.placements),
        layout: input.layout,
        title: input.title,
        intro: input.intro,
        buttonLabel: input.buttonLabel,
        thankYouText: input.thankYouText,
        targeting: JSON.stringify(input.targeting ?? {}),
        syncOptions: JSON.stringify(input.syncOptions ?? {}),
        translations: JSON.stringify(input.translations ?? {}),
        templateId: input.templateId ?? null,
        templateVersion: input.templateVersion ?? null,
        rotation: input.rotation ?? false,
        rotationWeight: input.rotationWeight ?? 2,
        learnAndStop: input.learnAndStop ?? false,
        designJson: JSON.stringify(input.design ?? DEFAULT_DESIGN),
      },
      select: { id: true },
    });

    await persistQuestions(tx, survey.id, input.questions, { hasResponses: false });

    // Default the channel-report question to the first choice question.
    const channelQuestion = await tx.question.findFirst({
      where: { surveyId: survey.id, type: { in: ["single_choice", "dropdown"] } },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    if (channelQuestion) {
      await tx.survey.update({
        where: { id: survey.id },
        data: { channelReportQuestionId: input.channelReportQuestionId ?? channelQuestion.id },
      });
    }

    return survey.id;
  });

  await invalidateConfig(shopId);
  return getEditorSurvey(shopId, created);
}

/**
 * Save edits to a survey.
 *
 * Draft surveys (never published) write straight to the definition tables, as
 * they always have. Live and paused surveys instead store a DRAFT: shoppers keep
 * seeing the published version until the merchant publishes (S7). The draft is
 * the full editable definition (questions, design, targeting, placements), so
 * publishing can apply it in one transaction.
 */
export async function updateSurvey(
  shopId: string,
  surveyId: string,
  input: SurveyInput,
  expectedRevision?: number,
): Promise<EditorSurvey> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });
  assertRevision(expectedRevision, existing.revision);

  assertValid(inputToDefinition(input, surveyId));

  const wasActive = existing.status === "active";
  const isLiveOrPaused = existing.status === "active" || existing.status === "paused";

  if (isLiveOrPaused) {
    // Hold the change back as a draft. One row update; no polling (section 6.6).
    await db.survey.update({
      where: { id: surveyId },
      data: { draft: JSON.stringify(input), draftUpdatedAt: new Date(), revision: { increment: 1 } },
    });
    await invalidateConfig(shopId);
    logger.info("survey_draft_saved", { shop_id: shopId, survey_id: surveyId });
    return getEditorSurvey(shopId, surveyId);
  }

  const hasResponses = existing.responseCount > 0;

  await db.$transaction(async (tx) => {
    await tx.survey.update({
      where: { id: surveyId },
      data: {
        name: input.name,
        status: input.status ?? existing.status,
        priority: input.priority ?? existing.priority,
        placements: JSON.stringify(input.placements),
        layout: input.layout,
        title: input.title,
        intro: input.intro,
        buttonLabel: input.buttonLabel,
        thankYouText: input.thankYouText,
        channelReportQuestionId: input.channelReportQuestionId ?? existing.channelReportQuestionId,
        targeting: JSON.stringify(input.targeting ?? {}),
        syncOptions: JSON.stringify(input.syncOptions ?? {}),
        translations: JSON.stringify(input.translations ?? {}),
        templateId: input.templateId ?? existing.templateId,
        templateVersion: input.templateVersion ?? existing.templateVersion,
        rotation: input.rotation ?? existing.rotation,
        rotationWeight: input.rotationWeight ?? existing.rotationWeight,
        learnAndStop: input.learnAndStop ?? existing.learnAndStop,
        designJson: JSON.stringify(input.design ?? existing.designJson),
        // Bump the version on every save of an active survey, so responses
        // record which revision they answered.
        version: wasActive ? { increment: 1 } : existing.version,
        // Move the concurrency token so a second window holding the old value
        // is refused rather than clobbering this save.
        revision: { increment: 1 },
      },
    });

    await persistQuestions(tx, surveyId, input.questions, { hasResponses });
  });

  await invalidateConfig(shopId);
  logger.info("survey_saved", { shop_id: shopId, survey_id: surveyId });
  return getEditorSurvey(shopId, surveyId);
}

/**
 * Publish a live/paused survey's draft (S7).
 *
 * In one transaction: validate, apply the draft to the normal tables with the
 * existing rules (stable ids, archive when answers exist, version + 1), clear
 * the draft, then recompile. Any failure leaves everything untouched.
 */
export async function publishSurveyDraft(
  shopId: string,
  surveyId: string,
  expectedRevision?: number,
): Promise<EditorSurvey> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });
  if (existing.draft === null) throw new ValidationError("There is nothing to publish.", "Edit the survey first.", { field: "draft", code: "no_draft" });
  assertRevision(expectedRevision, existing.revision);

  const draftInput = parseJson<SurveyInput>(existing.draft, null as unknown as SurveyInput);
  assertValid(inputToDefinition(draftInput, surveyId));

  const hasResponses = existing.responseCount > 0;

  await db.$transaction(async (tx) => {
    await tx.survey.update({
      where: { id: surveyId },
      data: {
        name: draftInput.name,
        placements: JSON.stringify(draftInput.placements),
        layout: draftInput.layout,
        title: draftInput.title,
        intro: draftInput.intro,
        buttonLabel: draftInput.buttonLabel,
        thankYouText: draftInput.thankYouText,
        channelReportQuestionId: draftInput.channelReportQuestionId ?? existing.channelReportQuestionId,
        targeting: JSON.stringify(draftInput.targeting ?? {}),
        syncOptions: JSON.stringify(draftInput.syncOptions ?? {}),
        translations: JSON.stringify(draftInput.translations ?? {}),
        rotation: draftInput.rotation ?? existing.rotation,
        rotationWeight: draftInput.rotationWeight ?? existing.rotationWeight,
        learnAndStop: draftInput.learnAndStop ?? existing.learnAndStop,
        designJson: JSON.stringify(draftInput.design ?? parseJson(existing.designJson, DEFAULT_DESIGN)),
        version: { increment: 1 },
        revision: { increment: 1 },
        draft: null,
        draftUpdatedAt: null,
      },
    });

    await persistQuestions(tx, surveyId, draftInput.questions, { hasResponses });
  });

  await invalidateConfig(shopId);
  logger.info("survey_draft_published", { shop_id: shopId, survey_id: surveyId });
  return getEditorSurvey(shopId, surveyId);
}

/** Discard a draft (S7). The published survey is untouched. */
export async function discardSurveyDraft(shopId: string, surveyId: string): Promise<void> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });
  await db.survey.update({ where: { id: surveyId }, data: { draft: null, draftUpdatedAt: null, revision: { increment: 1 } } });
  await invalidateConfig(shopId);
}

export async function setSurveyStatus(shopId: string, surveyId: string, status: SurveyStatus): Promise<void> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });

  if (status === "active") {
    if (existing.questions.length === 0) {
      throw new ValidationError(
        "Add at least one question before activating.",
        "Open the survey and add a question, then activate it.",
        { field: "status", code: "no_questions" },
      );
    }
    const placements = parseJson<Placement[]>(existing.placements, []);
    if (placements.length === 0) {
      throw new ValidationError(
        "Choose where the survey shows before activating.",
        "Pick at least one placement, then activate it.",
        { field: "placements", code: "no_placements" },
      );
    }
  }

  await db.survey.update({ where: { id: surveyId }, data: { status, revision: { increment: 1 } } });
  await invalidateConfig(shopId);
}

export async function deleteSurvey(shopId: string, surveyId: string): Promise<void> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });

  // Cascades to questions, options, responses, answers and daily stats.
  await db.survey.delete({ where: { id: surveyId } });
  await invalidateConfig(shopId);
  logger.info("survey_deleted", { shop_id: shopId, survey_id: surveyId });
}

export async function duplicateSurvey(shopId: string, surveyId: string): Promise<EditorSurvey> {
  const source = await getEditorSurvey(shopId, surveyId);
  const input: SurveyInput = {
    name: `${source.name} (copy)`.slice(0, LIMITS.MAX_SURVEY_NAME),
    status: "draft",
    priority: source.priority,
    placements: source.placements,
    layout: source.layout,
    title: source.title,
    intro: source.intro,
    buttonLabel: source.buttonLabel,
    thankYouText: source.thankYouText,
    targeting: source.targeting,
    syncOptions: source.syncOptions,
    translations: source.translations,
    // Fresh ids so the copy owns its options.
    questions: source.questions.map(({ id: _id, options, ...question }) => ({
      ...question,
      options: options.map(({ id: _optionId, ...option }) => option),
    })),
  };
  return createSurvey(shopId, input);
}

export async function reorderSurveys(shopId: string, orderedIds: string[]): Promise<void> {
  await db.$transaction(
    orderedIds.map((id, index) =>
      db.survey.updateMany({ where: { id, shopId }, data: { priority: orderedIds.length - index } }),
    ),
  );
  await invalidateConfig(shopId);
}

// ---------------------------------------------------------------------------
// Compiled config
// ---------------------------------------------------------------------------

function toCompiledQuestion(question: SurveyWithQuestions["questions"][number]): CompiledQuestion {
  return {
    id: question.id,
    type: question.type,
    text: question.text,
    helpText: question.helpText,
    placeholder: question.placeholder,
    textMultiline: question.textMultiline,
    required: question.required,
    randomizeOptions: question.randomizeOptions,
    allowOther: question.allowOther,
    minSelections: question.minSelections,
    maxSelections: question.maxSelections,
    showIf: parseJson<ShowIf | null>(question.showIf, null),
    options: question.options
      .filter((option) => !option.archived)
      .map((option) => ({
        id: option.id,
        label: option.label,
        isOther: option.isOther,
        exclusive: option.exclusive,
        translations: parseJson(option.translations, {}),
      })),
    translations: parseJson(question.translations, {}),
  };
}

export function compileSurvey(row: SurveyWithQuestions): CompiledSurvey {
  const targeting = parseJson<Targeting>(row.targeting, {});
  return {
    id: row.id,
    version: row.version,
    priority: row.priority,
    placements: parseJson<Placement[]>(row.placements, []),
    layout: row.layout,
    title: row.title ?? DEFAULT_SURVEY_TEXT.title,
    intro: row.intro,
    buttonLabel: row.buttonLabel ?? DEFAULT_SURVEY_TEXT.buttonLabel,
    thankYouText: row.thankYouText ?? DEFAULT_SURVEY_TEXT.thankYouText,
    channelReportQuestionId: row.channelReportQuestionId,
    targeting,
    questions: row.questions.filter((q) => !q.archived).map(toCompiledQuestion),
    translations: parseJson(row.translations, {}),
    design: compileDesign(parseJson<Partial<DesignSettings>>(row.designJson, {})),
    rotation: row.rotation,
    rotationWeight: row.rotationWeight,
    paymentManualOnly: targeting.paymentManualOnly === true,
  };
}

/** Compile the design settings for the extension bundle. */
function compileDesign(design: Partial<DesignSettings>) {
  const resolved = resolveDesign(design);
  return {
    layout: resolved.layout,
    showProgress: resolved.showProgress,
    showTitle: resolved.showTitle,
    ratingStyle: resolved.ratingStyle,
    scaleLowLabel: resolved.scaleLowLabel,
    scaleHighLabel: resolved.scaleHighLabel,
    cardBorder: resolved.cardBorder,
    spacing: resolved.spacing,
  };
}

export function buildConfig(rows: SurveyWithQuestions[]): CompiledConfig {
  return { version: 1, surveys: rows.map(compileSurvey) };
}

const configCache = new Map<string, { config: CompiledConfig; at: number }>();
const CONFIG_TTL_MS = 60_000;

export async function invalidateConfig(shopId: string): Promise<void> {
  configCache.delete(shopId);
}

/**
 * The compiled config for a shop.
 *
 * Cached in memory for a minute. A save invalidates it explicitly, so the
 * cache TTL only bounds staleness for changes made outside this process.
 */
export async function getCompiledConfig(shopId: string): Promise<CompiledConfig> {
  const cached = configCache.get(shopId);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;

  const rows = await getActiveSurveys(shopId);
  const config = buildConfig(rows);
  const size = Buffer.byteLength(JSON.stringify(config), "utf8");
  if (size > LIMITS.MAX_COMPILED_CONFIG_BYTES) {
    logger.warn("compiled_config_too_large", { shop_id: shopId, bytes: size });
  }
  configCache.set(shopId, { config, at: Date.now() });
  return config;
}

/** Reset the cache. Test-only. */
export function clearConfigCache(): void {
  configCache.clear();
}

export { editorToDefinition };
