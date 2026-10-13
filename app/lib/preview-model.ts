/**
 * Turn a `SurveyDefinition` (from `buildSurveyDefinition`) into the `EditorSurvey`
 * shape the shared `SurveyPreview` component renders.
 *
 * The template library detail page (T2) and Quick setup (T3) both preview a
 * survey that does not exist in the database yet, so neither can read through
 * `getEditorSurvey`. Keeping the conversion here means the two screens preview
 * the same thing.
 *
 * Type-only import of `EditorSurvey`, so this stays free of the database.
 */

import type { SurveyDefinition } from "@shared/survey-rules";
import { resolveDesign } from "@shared/survey-rules";
import type { Placement } from "@shared/survey-config";
import { templateById } from "@shared/templates";
import type { EditorSurvey } from "~/lib/surveys.server";

export function definitionToPreview(
  definition: SurveyDefinition,
  options: { templateId?: string | null; templateVersion?: number | null; placements: Placement[]; design?: unknown },
): EditorSurvey {
  const template = options.templateId ? templateById(options.templateId) : undefined;
  return {
    id: "preview",
    name: definition.name ?? "",
    status: "draft",
    priority: 0,
    placements: options.placements,
    layout: definition.layout ?? "all",
    title: definition.title ?? "",
    intro: definition.intro ?? null,
    buttonLabel: definition.buttonLabel ?? "",
    thankYouText: definition.thankYouText ?? "",
    channelReportQuestionId: null,
    targeting: {},
    syncOptions: {},
    translations: {},
    version: options.templateVersion ?? template?.version ?? 1,
    responseCount: 0,
    templateId: options.templateId ?? null,
    templateVersion: options.templateVersion ?? null,
    rotation: false,
    rotationWeight: 2,
    learnAndStop: false,
    design: resolveDesign((options.design as object) ?? definition.design),
    draftUpdatedAt: null,
    hasDraft: false,
    updatedAt: new Date().toISOString(),
    questions: definition.questions.map((q, i) => ({
      id: q.id ?? `q${i}`,
      type: q.type,
      text: q.text,
      helpText: q.helpText ?? null,
      placeholder: q.placeholder ?? null,
      textMultiline: q.textMultiline ?? false,
      required: q.required ?? false,
      randomizeOptions: q.randomizeOptions ?? false,
      allowOther: q.allowOther ?? false,
      minSelections: q.minSelections ?? null,
      maxSelections: q.maxSelections ?? null,
      showIf: q.showIf ?? null,
      translations: {},
      archived: false,
      options: (q.options ?? []).map((o, j) => ({
        id: o.id ?? `o${i}_${j}`,
        label: o.label,
        isOther: o.isOther ?? false,
        exclusive: o.exclusive ?? false,
        archived: false,
        translations: {},
      })),
    })),
  };
}
