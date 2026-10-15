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
import { effectivePlan } from "~/lib/plans";
import { findShopById } from "~/lib/shop.server";
import { catalogPlanFromKey, definitionHasExclusiveOption, planIncludesGrowth } from "@shared/templates/catalog";
import { templateById } from "@shared/templates";
import { stableQuestionId } from "@shared/templates/resolve";
import { isEnabled } from "@shared/feature-flags";
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
  /** The template's stable option id this row came from, if any. */
  templateKey?: string | null;
};

export type EditorQuestion = Omit<SurveyQuestionDef, "options"> & {
  options: EditorOption[];
  /** The template's stable question id this row came from, if any. */
  templateKey?: string | null;
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
  /**
   * The row id for an existing question. Anything else (a template's stable id,
   * an editor placeholder, a source survey's id when duplicating) means "new";
   * show-if conditions may reference it and are remapped to the saved id.
   */
  id?: string;
  templateKey?: string | null;
  options?: Array<Omit<SurveyOptionDef, "id"> & { id?: string; templateKey?: string | null }>;
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

/**
 * `view: "published"` ignores any unpublished draft. Buyers are served the
 * published survey, so submit validation, Overview and Results must read it too;
 * only the Studio shows the draft.
 */
export function rowToEditor(
  row: SurveyWithQuestions,
  { view = "draft" }: { view?: "draft" | "published" } = {},
): EditorSurvey {
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
    // The Studio never shows removed (archived) questions or options: posting
    // them back used to resurrect them. Buyers' submit validation and results
    // read the published view, which keeps them for their labels.
    questions:
      view === "draft"
        ? row.questions
            .filter((question) => !question.archived)
            .map((question) => {
              const editor = toEditorQuestion(question);
              return { ...editor, options: editor.options.filter((option) => !option.archived) };
            })
        : row.questions.map(toEditorQuestion),
  };

  // A live/paused survey with unpublished changes shows the DRAFT in the
  // editor, so the merchant keeps editing their latest work. Overview and
  // Results read the published structure instead (section 6.6); this is only
  // the Studio's view.
  if (row.draft && view === "draft") {
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
    templateKey: question.templateKey,
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      isOther: option.isOther,
      exclusive: option.exclusive,
      archived: option.archived,
      translations: parseJson(option.translations, {}),
      templateKey: option.templateKey,
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
      // `||`, not `??`: the editor used to send "" for every new item, and two
      // new options sharing "" failed validation as duplicates.
      id: question.id || `new-q${index}`,
      options: question.options?.map((option, optionIndex) => ({
        ...option,
        id: option.id || `new-o${index}-${optionIndex}`,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Which survey wins a placement, and the list order. Ties on priority break on
 * creation order: `updatedAt` moves on every shopper answer, so it handed the
 * placement to whichever survey was answered last, forever.
 */
const SURVEY_ORDER: Prisma.SurveyOrderByWithRelationInput[] = [
  { priority: "desc" },
  { createdAt: "asc" },
  { id: "asc" },
];

export async function listSurveys(shopId: string): Promise<SurveyListItem[]> {
  const rows = await db.survey.findMany({
    where: { shopId },
    orderBy: SURVEY_ORDER,
    include: { _count: { select: { questions: { where: { archived: false } } } } },
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
    orderBy: SURVEY_ORDER,
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

/** A template's stable ids all start with this (see `stableQuestionId`). */
function templateKeyPrefix(templateId: string | null | undefined): string | null {
  return templateId ? stableQuestionId(templateId, "") : null;
}

/** Posted ids (stable, placeholder or a source survey's) -> saved row ids. */
type IdMap = Map<string, string>;

function remapShowIf(showIf: ShowIf | null | undefined, idMap: IdMap): ShowIf | null {
  if (!showIf) return null;
  return {
    ...showIf,
    questionId: idMap.get(showIf.questionId) ?? showIf.questionId,
    ...(showIf.optionIds ? { optionIds: showIf.optionIds.map((id) => idMap.get(id) ?? id) } : {}),
  };
}

async function persistQuestions(
  tx: Prisma.TransactionClient,
  surveyId: string,
  questions: SurveyInput["questions"],
  { hasResponses, templateId }: { hasResponses: boolean; templateId?: string | null },
): Promise<IdMap> {
  // Existing rows for this survey, so a posted id can be matched. Anything not
  // found here is new and gets a fresh id; an id from another question is never
  // updated in place (it would keep its old question).
  const existingQuestions = new Map(
    (
      await tx.question.findMany({ where: { surveyId }, select: { id: true, type: true, archived: true } })
    ).map((q) => [q.id, q]),
  );
  const existingOptions = new Map(
    (
      await tx.option.findMany({
        where: { question: { surveyId } },
        select: { id: true, questionId: true, archived: true },
      })
    ).map((o) => [o.id, o]),
  );
  const prefix = templateKeyPrefix(templateId);
  const templateKeyOf = (posted: string, explicit: string | null | undefined) =>
    explicit ?? (prefix && posted.startsWith(prefix) ? posted : null);

  const idMap: IdMap = new Map();
  const keptOptionIds = new Set<string>();
  const keptQuestionIds = new Set<string>();
  const conditions: Array<{ id: string; showIf: ShowIf | null | undefined }> = [];

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!;
    const posted = question.id ?? "";
    const existing = posted ? existingQuestions.get(posted) : undefined;

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
      // Written in a second pass, once every posted id has its saved id.
      showIf: null,
      translations: JSON.stringify(question.translations ?? {}),
    };

    let savedQuestionId: string;
    if (existing) {
      await tx.question.update({ where: { id: existing.id }, data });
      savedQuestionId = existing.id;
    } else {
      const created = await tx.question.create({
        data: { ...data, surveyId, archived: false, templateKey: templateKeyOf(posted, question.templateKey) },
        select: { id: true },
      });
      savedQuestionId = created.id;
    }
    if (posted) idMap.set(posted, savedQuestionId);
    keptQuestionIds.add(savedQuestionId);
    conditions.push({ id: savedQuestionId, showIf: question.showIf });

    const options = question.options ?? [];
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]!;
      const postedOption = option.id ?? "";
      const existingOption = postedOption ? existingOptions.get(postedOption) : undefined;
      const optionData = {
        position: j,
        label: option.label,
        isOther: option.isOther ?? false,
        exclusive: option.exclusive ?? false,
        translations: JSON.stringify(option.translations ?? {}),
      };
      let savedOptionId: string;
      if (existingOption && existingOption.questionId === savedQuestionId) {
        await tx.option.update({ where: { id: existingOption.id }, data: optionData });
        savedOptionId = existingOption.id;
      } else {
        const created = await tx.option.create({
          data: {
            ...optionData,
            archived: false,
            questionId: savedQuestionId,
            templateKey: templateKeyOf(postedOption, option.templateKey),
          },
          select: { id: true },
        });
        savedOptionId = created.id;
      }
      if (postedOption) idMap.set(postedOption, savedOptionId);
      keptOptionIds.add(savedOptionId);
    }
  }

  // Show-if conditions name posted ids: a template's stable ids, an editor
  // placeholder for a question or option added in the same edit, or the source
  // survey's ids when duplicating. Rewrite them to the saved ids. Fixed option
  // ids (yes/no, satisfaction) are not in the map and stay as they are.
  for (const { id, showIf } of conditions) {
    const remapped = remapShowIf(showIf, idMap);
    if (remapped) await tx.question.update({ where: { id }, data: { showIf: JSON.stringify(remapped) } });
  }

  // Removed questions and options: delete when the survey has no answers yet
  // (nothing to lose), otherwise archive so results keep their labels.
  const removedQuestions = [...existingQuestions.keys()].filter((id) => !keptQuestionIds.has(id));
  const removedOptions = [...existingOptions.keys()].filter((id) => !keptOptionIds.has(id));

  if (hasResponses) {
    if (removedOptions.length > 0) {
      await tx.option.updateMany({ where: { id: { in: removedOptions } }, data: { archived: true } });
    }
    if (removedQuestions.length > 0) {
      await tx.question.updateMany({ where: { id: { in: removedQuestions } }, data: { archived: true } });
    }
  } else {
    // No answers: a hard delete is safe and keeps a draft clean.
    await tx.option.deleteMany({ where: { id: { in: removedOptions } } });
    await tx.question.deleteMany({ where: { id: { in: removedQuestions } } });
  }

  return idMap;
}

/**
 * Server-side checks on everything the Studio posts besides the questions,
 * which used to be mass-assigned from the JSON with client-only limits.
 * Returns the input with placements de-duplicated and the design resolved.
 */
function sanitizeSurveyInput(input: SurveyInput): SurveyInput {
  const fail = (field: string, code: string, message: string): never => {
    throw new ValidationError(message, "Check the highlighted field and save again.", { field, code });
  };

  if (!Array.isArray(input.questions)) fail("questions", "invalid", "The survey could not be read.");
  if (!Array.isArray(input.placements)) fail("placements", "invalid_placement", "Choose where the survey shows.");
  const enabled = new Set<Placement>(["thank_you", "order_status"]);
  if (isEnabled("ONSITE_SURVEYS")) enabled.add("onsite");
  if (isEnabled("SURVEY_LINK_PAGE")) enabled.add("link");
  for (const placement of input.placements) {
    if (!enabled.has(placement)) fail("placements", "invalid_placement", "That placement is not available.");
  }
  const placements = [...new Set(input.placements)];

  if (input.rotationWeight !== undefined) {
    const w = input.rotationWeight;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 10) {
      fail("rotationWeight", "invalid_rotation_weight", "The rotation weight must be a whole number from 1 to 10.");
    }
  }

  const targeting = input.targeting ?? {};
  if (typeof targeting !== "object" || Array.isArray(targeting)) fail("targeting", "invalid_targeting", "Targeting could not be read.");
  if (targeting.samplePercent != null) {
    const p = targeting.samplePercent;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 100) {
      fail("targeting.samplePercent", "invalid_sample", "The sample must be a whole number from 1 to 100.");
    }
  }
  if (targeting.maxResponses != null) {
    const m = targeting.maxResponses;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1) {
      fail("targeting.maxResponses", "invalid_max_responses", "The response limit must be 1 or more.");
    }
  }
  for (const key of ["minValue", "maxValue"] as const) {
    const v = targeting[key];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      fail(`targeting.${key}`, "invalid_order_value", "Order values must be 0 or more.");
    }
  }
  const listLimit = (key: "productIds" | "collectionIds" | "resolvedProductIds" | "countries" | "languages", max: number) => {
    const list = targeting[key];
    if (list === undefined) return;
    if (!Array.isArray(list) || list.length > max || list.some((v) => typeof v !== "string" || v.length > 64)) {
      fail(`targeting.${key}`, "invalid_targeting", "Targeting has too many entries.");
    }
  };
  listLimit("productIds", LIMITS.MAX_TARGET_PRODUCTS);
  listLimit("resolvedProductIds", 500);
  listLimit("collectionIds", LIMITS.MAX_TARGET_COLLECTIONS);
  listLimit("countries", 250);
  listLimit("languages", 50);

  let design: DesignSettings | undefined;
  if (input.design !== undefined) {
    design = resolveDesign(input.design);
    const valid =
      (design.layout === "all" || design.layout === "one_by_one") &&
      typeof design.showProgress === "boolean" &&
      typeof design.showTitle === "boolean" &&
      (design.ratingStyle === "numbers" || design.ratingStyle === "stars") &&
      (design.cardBorder === "border" || design.cardBorder === "no_border") &&
      (design.spacing === "compact" || design.spacing === "comfortable") &&
      typeof design.scaleLowLabel === "string" &&
      design.scaleLowLabel.length <= LIMITS.MAX_SCALE_LABEL &&
      typeof design.scaleHighLabel === "string" &&
      design.scaleHighLabel.length <= LIMITS.MAX_SCALE_LABEL;
    if (!valid) fail("design", "invalid_design", "The design settings could not be read.");
  }

  // Translations ship to every buyer in the compiled config. Bound each string
  // by the limit of the field it translates (the longest is 200 characters).
  const tooLong = (value: unknown, max: number): boolean => {
    if (typeof value === "string") return value.length > max;
    if (value && typeof value === "object") return Object.values(value).some((v) => tooLong(v, max));
    return false;
  };
  if (tooLong(input.translations ?? {}, LIMITS.MAX_QUESTION_TEXT)) {
    fail("translations", "translation_too_long", "A translation is too long.");
  }
  input.questions.forEach((question, index) => {
    if (tooLong(question.translations ?? {}, LIMITS.MAX_QUESTION_TEXT)) {
      fail(`questions[${index}].translations`, "translation_too_long", "A translation is too long.");
    }
    (question.options ?? []).forEach((option, optionIndex) => {
      if (tooLong(option.translations ?? {}, LIMITS.MAX_OPTION_LABEL)) {
        fail(`questions[${index}].options[${optionIndex}].translations`, "translation_too_long", "A translation is too long.");
      }
    });
  });

  const syncOptions = input.syncOptions ?? {};
  if (typeof syncOptions !== "object" || Array.isArray(syncOptions) || JSON.stringify(syncOptions).length > 8_000) {
    fail("syncOptions", "invalid_sync_options", "The sync settings could not be read.");
  }

  return { ...input, placements, ...(design ? { design } : {}) };
}

/**
 * Refuse changing the type of a question that already has answers: the stored
 * answers would be re-read under the new type (a channel option read as an NPS
 * score). Relabelling stays allowed, so typos can be fixed.
 */
function assertTypesUnchanged(input: SurveyInput, existing: SurveyWithQuestions): void {
  if (existing.responseCount === 0) return;
  const types = new Map(existing.questions.map((q) => [q.id, q.type]));
  input.questions.forEach((question, index) => {
    const before = question.id ? types.get(question.id) : undefined;
    if (before && before !== question.type) {
      throw new ValidationError(
        "A question that already has answers cannot change type.",
        "Add a new question instead, and remove the old one.",
        { field: `questions[${index}].type`, code: "type_locked" },
      );
    }
  });
}

/** Refuse activation past the active-survey limit (not counting `exceptId`). */
async function assertActiveLimit(client: Prisma.TransactionClient | typeof db, shopId: string, exceptId?: string): Promise<void> {
  const active = await client.survey.count({
    where: { shopId, status: "active", ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (active >= LIMITS.MAX_ACTIVE_SURVEYS) {
    throw new ValidationError(
      `You can have at most ${LIMITS.MAX_ACTIVE_SURVEYS} live surveys.`,
      "Pause a survey you no longer need, then try again.",
      { field: "status", code: "too_many_active" },
    );
  }
}

/** Whether another live survey limit would be exceeded by activating `surveyId`. */
export async function isOverActiveLimit(shopId: string, surveyId: string): Promise<boolean> {
  const active = await db.survey.count({ where: { shopId, status: "active", id: { not: surveyId } } });
  return active >= LIMITS.MAX_ACTIVE_SURVEYS;
}

/**
 * Write a merchant change only if the revision is still the one read. The check
 * and the write are one statement, so two windows saving at once cannot both
 * succeed, and a publish cannot commit a draft that a newer save replaced.
 */
async function claimRevision(
  client: Prisma.TransactionClient | typeof db,
  surveyId: string,
  revision: number,
  data: Prisma.SurveyUpdateManyMutationInput,
): Promise<void> {
  const result = await client.survey.updateMany({
    where: { id: surveyId, revision },
    data: { ...data, revision: { increment: 1 } },
  });
  if (result.count === 0) throw new ConflictError(undefined, { expected: revision });
}

/**
 * Reject a create that uses a Growth-only feature on a plan that does not
 * include it. The library only hides the button; a crafted POST to the
 * create/setup/duplicate intents could otherwise hand a Free shop the Growth
 * feature (an exclusive option, T6, or a by-product breakdown, T8).
 *
 * Content-based for the exclusive option, so the Lite build (which strips it)
 * still creates on Free; the by-product breakdown cannot be subset away, so a
 * template that ships it is blocked outright on Free.
 */
async function assertPlanAllowsSurvey(shopId: string, input: SurveyInput): Promise<void> {
  const shop = await findShopById(shopId);
  const plan = catalogPlanFromKey(effectivePlan(shop ?? { plan: null, planStatus: "" }));
  if (planIncludesGrowth(plan)) return;

  const definition = inputToDefinition(input);
  const template = input.templateId ? templateById(input.templateId) : undefined;
  const blocked =
    definitionHasExclusiveOption(definition) || template?.resultsHints?.byProduct === true;
  if (!blocked) return;

  throw new ValidationError(
    "That survey uses a feature included in a paid plan.",
    "Use the Lite version, or upgrade to unlock it.",
    { field: "templateId", code: "template_plan_locked" },
  );
}

/**
 * Reject an edit that ADDS a Growth-only feature on the Free plan, while
 * grandfathering a survey that already has one.
 *
 * A merchant who used a Growth feature while paying and then downgraded keeps
 * their existing survey; they just cannot switch the feature on anew. Without
 * the grandfather a downgrade would make an existing survey unsaveable.
 */
async function assertPlanAllowsEdit(
  shopId: string,
  input: SurveyInput,
  existing: SurveyWithQuestions,
): Promise<void> {
  const shop = await findShopById(shopId);
  const plan = catalogPlanFromKey(effectivePlan(shop ?? { plan: null, planStatus: "" }));
  if (planIncludesGrowth(plan)) return;

  const next = inputToDefinition(input);
  if (!definitionHasExclusiveOption(next)) return;
  // Grandfather per option: only an option that is ALREADY exclusive may stay
  // so. One exclusive option anywhere used to unlock the feature everywhere.
  const alreadyExclusive = new Set(
    existing.questions.flatMap((q) => q.options.filter((o) => o.exclusive).map((o) => o.id)),
  );
  const addsExclusive = input.questions.some((q) =>
    (q.options ?? []).some((o) => o.exclusive === true && !(o.id && alreadyExclusive.has(o.id))),
  );
  if (!addsExclusive) return;

  throw new ValidationError(
    "That option is included in a paid plan.",
    "Upgrade to use the exclusive option, or turn it off.",
    { field: "questions", code: "template_plan_locked" },
  );
}

export async function createSurvey(shopId: string, rawInput: SurveyInput): Promise<EditorSurvey> {
  const input = sanitizeSurveyInput(rawInput);
  await assertPlanAllowsSurvey(shopId, input);
  assertValid(inputToDefinition(input));

  const created = await db.$transaction(async (tx) => {
    // Serialise creates per shop so the limits below hold under parallel
    // requests (a double-clicked "Create" or two tabs).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`survey-create:${shopId}`}))`;
    const total = await tx.survey.count({ where: { shopId } });
    if (total >= LIMITS.MAX_SURVEYS_TOTAL) {
      throw new ValidationError(
        `You can have at most ${LIMITS.MAX_SURVEYS_TOTAL} surveys.`,
        "Delete a survey you no longer need, then try again.",
        { field: "name", code: "too_many_surveys" },
      );
    }
    if (input.status === "active") await assertActiveLimit(tx, shopId);

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

    const idMap = await persistQuestions(tx, survey.id, input.questions, {
      hasResponses: false,
      templateId: input.templateId,
    });

    // Default the channel-report question to the first choice question.
    const channelQuestion = await tx.question.findFirst({
      where: { surveyId: survey.id, type: { in: ["single_choice", "dropdown"] } },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    const requested = input.channelReportQuestionId ? idMap.get(input.channelReportQuestionId) : undefined;
    if (requested || channelQuestion) {
      await tx.survey.update({
        where: { id: survey.id },
        data: { channelReportQuestionId: requested ?? channelQuestion!.id },
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
 *
 * Status, priority and template provenance are never taken from the posted
 * survey: status changes go through `setSurveyStatus` (with its guards),
 * priority through `reorderSurveys`, and the template is fixed at creation.
 */
export async function updateSurvey(
  shopId: string,
  surveyId: string,
  rawInput: SurveyInput,
  expectedRevision?: number,
): Promise<EditorSurvey> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });
  assertRevision(expectedRevision, existing.revision);
  const revision = expectedRevision ?? existing.revision;

  const input = sanitizeSurveyInput(rawInput);
  await assertPlanAllowsEdit(shopId, input, existing);
  assertValid(inputToDefinition(input, surveyId));
  assertTypesUnchanged(input, existing);

  const wasActive = existing.status === "active";
  const isLiveOrPaused = existing.status === "active" || existing.status === "paused";

  if (isLiveOrPaused) {
    // Hold the change back as a draft. One row update; no polling (section 6.6).
    await claimRevision(db, surveyId, revision, { draft: JSON.stringify(input), draftUpdatedAt: new Date() });
    await invalidateConfig(shopId);
    logger.info("survey_draft_saved", { shop_id: shopId, survey_id: surveyId });
    return getEditorSurvey(shopId, surveyId);
  }

  const hasResponses = existing.responseCount > 0;

  await db.$transaction(async (tx) => {
    await claimRevision(tx, surveyId, revision, {
      name: input.name,
      placements: JSON.stringify(input.placements),
      layout: input.layout,
      title: input.title,
      intro: input.intro,
      buttonLabel: input.buttonLabel,
      thankYouText: input.thankYouText,
      targeting: JSON.stringify(input.targeting ?? {}),
      syncOptions: JSON.stringify(input.syncOptions ?? {}),
      translations: JSON.stringify(input.translations ?? {}),
      rotation: input.rotation ?? existing.rotation,
      rotationWeight: input.rotationWeight ?? existing.rotationWeight,
      learnAndStop: input.learnAndStop ?? existing.learnAndStop,
      // `designJson` is already a JSON string; only a posted design is encoded.
      designJson: input.design ? JSON.stringify(input.design) : existing.designJson,
      // Bump the version on every save of an active survey, so responses
      // record which revision they answered.
      ...(wasActive ? { version: { increment: 1 } } : {}),
    });

    const idMap = await persistQuestions(tx, surveyId, input.questions, {
      hasResponses,
      templateId: existing.templateId,
    });
    await applyChannelReportQuestion(tx, surveyId, input.channelReportQuestionId, idMap);
  });

  await invalidateConfig(shopId);
  logger.info("survey_saved", { shop_id: shopId, survey_id: surveyId });
  return getEditorSurvey(shopId, surveyId);
}

/** Point the channel report at the posted question, through the id map. */
async function applyChannelReportQuestion(
  tx: Prisma.TransactionClient,
  surveyId: string,
  posted: string | null | undefined,
  idMap: IdMap,
): Promise<void> {
  if (!posted) return;
  const id = idMap.get(posted);
  if (id) await tx.survey.update({ where: { id: surveyId }, data: { channelReportQuestionId: id } });
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
  const noDraft = () =>
    new ValidationError("There is nothing to publish.", "Edit the survey first.", { field: "draft", code: "no_draft" });
  if (existing.draft === null) throw noDraft();
  assertRevision(expectedRevision, existing.revision);
  const revision = expectedRevision ?? existing.revision;

  const parsedDraft = parseJson<SurveyInput | null>(existing.draft, null);
  if (!parsedDraft || typeof parsedDraft !== "object" || !Array.isArray(parsedDraft.questions)) throw noDraft();
  const draftInput = sanitizeSurveyInput(parsedDraft);
  await assertPlanAllowsEdit(shopId, draftInput, existing);
  assertValid(inputToDefinition(draftInput, surveyId));
  assertTypesUnchanged(draftInput, existing);
  if (existing.status === "active" && draftInput.placements.length === 0) {
    // The same guard as activation: a live survey with no placement shows
    // nowhere while reading "active".
    throw new ValidationError(
      "Choose where the survey shows before publishing.",
      "Pick at least one placement, or pause the survey instead.",
      { field: "placements", code: "no_placements" },
    );
  }

  const hasResponses = existing.responseCount > 0;

  await db.$transaction(async (tx) => {
    await claimRevision(tx, surveyId, revision, {
      name: draftInput.name,
      placements: JSON.stringify(draftInput.placements),
      layout: draftInput.layout,
      title: draftInput.title,
      intro: draftInput.intro,
      buttonLabel: draftInput.buttonLabel,
      thankYouText: draftInput.thankYouText,
      targeting: JSON.stringify(draftInput.targeting ?? {}),
      syncOptions: JSON.stringify(draftInput.syncOptions ?? {}),
      translations: JSON.stringify(draftInput.translations ?? {}),
      rotation: draftInput.rotation ?? existing.rotation,
      rotationWeight: draftInput.rotationWeight ?? existing.rotationWeight,
      learnAndStop: draftInput.learnAndStop ?? existing.learnAndStop,
      designJson: draftInput.design ? JSON.stringify(draftInput.design) : existing.designJson,
      version: { increment: 1 },
      draft: null,
      draftUpdatedAt: null,
    });

    const idMap = await persistQuestions(tx, surveyId, draftInput.questions, {
      hasResponses,
      templateId: existing.templateId,
    });
    await applyChannelReportQuestion(tx, surveyId, draftInput.channelReportQuestionId, idMap);
  });

  await invalidateConfig(shopId);
  logger.info("survey_draft_published", { shop_id: shopId, survey_id: surveyId });
  return getEditorSurvey(shopId, surveyId);
}

/** Discard a draft (S7). The published survey is untouched. */
export async function discardSurveyDraft(shopId: string, surveyId: string, expectedRevision?: number): Promise<void> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });
  assertRevision(expectedRevision, existing.revision);
  await claimRevision(db, surveyId, expectedRevision ?? existing.revision, { draft: null, draftUpdatedAt: null });
  await invalidateConfig(shopId);
}

export async function setSurveyStatus(shopId: string, surveyId: string, status: SurveyStatus): Promise<void> {
  const existing = await getSurveyRow(shopId, surveyId);
  if (!existing) throw new NotFoundError("That survey does not exist.", { surveyId });

  if (status === "paused" && existing.status === "draft") {
    // Pausing is for a live survey; a never-published draft has nothing to pause.
    throw new ValidationError("Only a live survey can be paused.", "Go live first, or keep editing the draft.", {
      field: "status",
      code: "not_live",
    });
  }

  if (status === "active") {
    if (!existing.questions.some((question) => !question.archived)) {
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

  await db.$transaction(async (tx) => {
    if (status === "active" && existing.status !== "active") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`survey-create:${shopId}`}))`;
      await assertActiveLimit(tx, shopId, surveyId);
    }
    await tx.survey.update({ where: { id: surveyId }, data: { status, revision: { increment: 1 } } });
  });
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

/**
 * Copy the PUBLISHED survey (what buyers see), live questions only. The source
 * ids are posted as-is: they do not exist in the copy, so every row is new, and
 * show-if conditions and the channel report are remapped to the copy's ids.
 */
export async function duplicateSurvey(shopId: string, surveyId: string): Promise<EditorSurvey> {
  const row = await getSurveyRow(shopId, surveyId);
  if (!row) throw new NotFoundError("That survey does not exist.", { surveyId });
  const source = rowToEditor(row, { view: "published" });
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
    channelReportQuestionId: source.channelReportQuestionId,
    targeting: source.targeting,
    syncOptions: source.syncOptions,
    translations: source.translations,
    templateId: source.templateId,
    templateVersion: source.templateVersion,
    rotation: source.rotation,
    rotationWeight: source.rotationWeight,
    learnAndStop: source.learnAndStop,
    design: source.design,
    questions: source.questions
      .filter((question) => !question.archived)
      .map(({ archived: _archived, options, ...question }) => ({
        ...question,
        options: options.filter((option) => !option.archived).map(({ archived: _a, ...option }) => option),
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
    responseCount: row.responseCount,
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
