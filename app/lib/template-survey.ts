/**
 * Turn a template into a ready-to-edit survey in one step.
 *
 * Replaces the old three-step Quick setup wizard: choosing a template now
 * creates a draft with sensible defaults and opens it in the editor, where the
 * merchant changes anything they want and presses Go live. Pure (no database,
 * no Shopify), so it is unit-tested directly.
 *
 * The survey is written in the merchant's admin language, and every other
 * language the templates ship is stored as a translation, so a buyer whose
 * checkout is in German reads the German wording without the merchant doing
 * anything. The editor drops a translation as soon as the merchant rewords that
 * text, so a buyer never reads an outdated version of an edited question.
 */

import { buildSurveyDefinition } from "@shared/templates/resolve";
import { TEMPLATE_LOCALES, templateText } from "@shared/templates/locales";
import {
  catalogPlanFromKey,
  templateHasFreeVersion,
  templateLockedForPlan,
  templatePlacements,
} from "@shared/templates/catalog";
import type { RegionPack } from "@shared/templates/packs";
import type { TemplateDefinition } from "@shared/templates/types";
import { planHas, planTier } from "@shared/plan-features";
import type { Targeting } from "@shared/survey-config";
import type { SurveyDefinition } from "@shared/survey-rules";
import type { SurveyInput } from "~/lib/surveys.server";

export type TemplateSurveyResult =
  | { ok: true; input: SurveyInput; lite: boolean }
  | { ok: false; reason: "needs_paid_plan" };

/** Whether this plan can create the template at all (full or Free version). */
export function templateUsableOnPlan(template: TemplateDefinition, plan: unknown): boolean {
  return !templateLockedForPlan(template, catalogPlanFromKey(plan)) || templateHasFreeVersion(template);
}

export function templateSurveyInput(params: {
  template: TemplateDefinition;
  /** The merchant's admin language: the survey's default text. */
  locale: string;
  region: RegionPack;
  plan: unknown;
}): TemplateSurveyResult {
  const { template, locale, region } = params;
  const catalogPlan = catalogPlanFromKey(params.plan);
  const locked = templateLockedForPlan(template, catalogPlan);
  if (locked && !templateHasFreeVersion(template)) return { ok: false, reason: "needs_paid_plan" };
  // On a plan without the full version, the Free version is used. The server
  // create path checks this again, so a crafted request cannot skip it.
  const lite = locked;

  const build = (forLocale: string) => buildSurveyDefinition({ template, locale: forLocale, region, lite });
  const definition = build(locale);
  const others = TEMPLATE_LOCALES.filter((code) => code !== locale).map((code) => ({ code, def: build(code) }));

  const targeting: Targeting = {};
  if (template.defaults.audience !== "everyone") targeting.customerType = template.defaults.audience;
  if (template.defaults.paymentManualOnly) targeting.paymentManualOnly = true;

  const input: SurveyInput = {
    name: templateText(locale, template.nameKey),
    status: "draft",
    placements: templatePlacements(template),
    layout: definition.layout ?? "all",
    title: definition.title ?? "",
    intro: definition.intro ?? null,
    buttonLabel: definition.buttonLabel ?? "",
    thankYouText: definition.thankYouText ?? "",
    templateId: template.id,
    templateVersion: template.version,
    // Auto-stop is a Scale feature; below it the template's default is ignored.
    learnAndStop: (template.defaults.learnAndStop ?? false) && planHas(planTier(params.plan), "auto_stop"),
    design: definition.design ?? undefined,
    targeting,
    syncOptions: {},
    translations: frameTranslations(others),
    questions: definition.questions.map((question, index) => ({
      ...question,
      translations: questionTranslations(others, index, question.id),
      options: question.options?.map((option) => ({
        ...option,
        translations: optionTranslations(others, index, option.id, option.label),
      })),
    })),
  };
  return { ok: true, input, lite };
}

type Localized = { code: string; def: SurveyDefinition };

/** The survey frame (title, intro, button, thank-you) in every other language. */
function frameTranslations(others: Localized[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { code, def } of others) {
    out[code] = {
      title: def.title ?? "",
      ...(def.intro ? { intro: def.intro } : {}),
      buttonLabel: def.buttonLabel ?? "",
      thankYouText: def.thankYouText ?? "",
    };
  }
  return out;
}

/**
 * One question's text in every other language. The definitions are built from
 * the same template with the same switches, so question `index` is the same
 * question in each (its stable id is asserted equal, never assumed).
 */
function questionTranslations(others: Localized[], index: number, questionId: string | undefined) {
  const out: Record<string, { text: string; helpText?: string; placeholder?: string }> = {};
  for (const { code, def } of others) {
    const question = def.questions[index];
    if (!question || question.id !== questionId) continue;
    out[code] = {
      text: question.text,
      ...(question.helpText ? { helpText: question.helpText } : {}),
      ...(question.placeholder ? { placeholder: question.placeholder } : {}),
    };
  }
  return out;
}

/**
 * One option's label in every other language. A label that reads the same in a
 * language (brand names such as "Instagram") is left out: the buyer falls back
 * to the default label, which is identical, and the survey stays small.
 */
function optionTranslations(others: Localized[], index: number, optionId: string | undefined, label: string) {
  const out: Record<string, string> = {};
  if (!optionId) return out;
  for (const { code, def } of others) {
    const option = def.questions[index]?.options?.find((o) => o.id === optionId);
    if (option && option.label !== label) out[code] = option.label;
  }
  return out;
}
