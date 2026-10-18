/**
 * Turn a template definition into a real survey definition.
 *
 * Pure and unit-tested. Everything a created survey needs — question text,
 * option labels, show-if rules, design, targeting defaults — is derived here, so
 * the library, Quick setup and the Studio all agree, and a survey is an
 * independent copy (later template changes never touch it).
 */

import {
  DEFAULT_DESIGN,
  DEFAULT_NPS_SCALE,
  resolveDesign,
  type DesignSettings,
  type ShowIf,
  type SurveyDefinition,
  type SurveyOptionDef,
  type SurveyQuestionDef,
} from "../survey-rules";
import { templateText } from "./locales";
import { packFor, type RegionPack } from "./packs";
import type { PackFamily, TemplateDefinition, TemplateQuestion } from "./types";

/**
 * Turn a template question key into a stable survey option id.
 *
 * Stable across languages and re-runs: derived from the template id + option
 * key, never from the translated label. That is what lets answers aggregate and
 * what lets tags be identical in every language.
 */
export function stableOptionId(templateId: string, questionKey: string, optionKey: string): string {
  return `${slug(templateId)}_${slug(questionKey)}_${slug(optionKey)}`;
}

/** Stable survey question id. */
export function stableQuestionId(templateId: string, questionKey: string): string {
  return `${slug(templateId)}_${slug(questionKey)}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The questions included in a version (full or Lite). */
function includedQuestions(template: TemplateDefinition, lite: boolean): TemplateQuestion[] {
  if (!lite) return template.questions;
  const allowed = new Set(template.liteQuestionKeys);
  return template.questions.filter((q) => allowed.has(q.key));
}

/**
 * Build the survey definition from a template.
 *
 * `locale` selects the language the created survey's default text is written in.
 * `region` picks the channel/occasion pack. `lite` restricts to the Free subset.
 * `toggles` lets Quick setup turn optional questions off (keyed by question key).
 */
export function buildSurveyDefinition(params: {
  template: TemplateDefinition;
  locale: string;
  region: RegionPack;
  lite?: boolean;
  /** Optional questions the merchant turned off in Quick setup. */
  toggles?: Record<string, boolean>;
  /** Override a question's text/options (inline edits in Quick setup). */
  overrides?: Record<string, { text?: string; helpText?: string; placeholder?: string; options?: Record<string, string> }>;
  /** Override the answer-pack family for profile questions (Taste Profile industry). */
  profileFamily?: PackFamily;
  design?: Partial<DesignSettings>;
}): SurveyDefinition {
  const { template, locale, region, lite = false } = params;
  const incoming = includedQuestions(template, lite);
  // Lite is the Free-plan subset, so it must not carry a Growth-only feature.
  // What is Growth is the exclusive *behaviour* (T6: ticking "None of these"
  // clears the rest), not the answer itself. Lite keeps the answer as an
  // ordinary option: dropping it made a buyer who only shops with you, or wants
  // no messages, pick something untrue or abandon the survey.
  const liteOptions = lite
    ? incoming.map((q) =>
        q.options ? { ...q, options: q.options.map((o) => (o.exclusive ? { ...o, exclusive: false } : o)) } : q,
      )
    : incoming;
  // A profile question's pack is an industry the merchant picks in Quick setup,
  // so a `profileFamily` replaces the template's default beauty pack. The
  // question text then comes from the chosen pack, not the template's copy.
  const questions = params.profileFamily
    ? liteOptions.map((q) => (q.pack && q.pack.startsWith("profiles_") ? { ...q, pack: params.profileFamily } : q))
    : liteOptions;
  const t = (key: string) => templateText(locale, key);

  const includedKeys = new Set(questions.map((q) => q.key));
  const enabled = (q: TemplateQuestion) => {
    // Required questions are always in. An optional question is in unless the
    // merchant (or Lite) turned it off.
    if (!q.required) {
      if (params.toggles && params.toggles[q.key] === false) return false;
    }
    // A question whose show-if dependency was excluded cannot render.
    if (q.showIf && !includedKeys.has(q.showIf.questionKey)) return false;
    return true;
  };

  const surveyQuestions: SurveyQuestionDef[] = [];

  for (const q of questions) {
    if (!enabled(q)) continue;

    const override = params.overrides?.[q.key];
    const id = stableQuestionId(template.id, q.key);
    const showIf = buildShowIf(template, q, questions, includedKeys, region);

    const def: SurveyQuestionDef = {
      id,
      type: q.type,
      text: override?.text ?? t(q.textKey),
      helpText: override?.helpText ?? (q.helpTextKey ? t(q.helpTextKey) : null),
      placeholder: override?.placeholder ?? (q.placeholderKey ? t(q.placeholderKey) : null),
      textMultiline: q.multiline ?? false,
      required: q.required,
      randomizeOptions: q.randomize ?? false,
      allowOther: false,
      minSelections: q.maxSelections != null ? 1 : null,
      maxSelections: q.maxSelections ?? null,
      showIf,
      options: resolveQuestionOptions(template, q, region, locale, override?.options),
    };
    surveyQuestions.push(def);
  }

  const design = resolveDesign({ ...(template.defaults.design ?? {}), ...(params.design ?? {}) });

  return {
    name: t(template.nameKey),
    title: DEFAULT_SURVEY_TITLE_FROM_LOCALE(locale),
    intro: DEFAULT_INTRO_FROM_LOCALE(locale),
    buttonLabel: DEFAULT_BUTTON_FROM_LOCALE(locale),
    thankYouText: DEFAULT_THANKYOU_FROM_LOCALE(locale),
    layout: design.layout,
    design,
    questions: surveyQuestions,
  };
}

// Default frame text, kept in the admin bundle (see app/lib/i18n/locales). These
// are the same four sentences as `DEFAULT_SURVEY_TEXT` in survey-config.ts; the
// template module duplicates them as literals so it stays dependency-free and
// usable from a plain Node test. The admin overrides them with translated text
// from the survey editor when the merchant edits the survey.
function DEFAULT_SURVEY_TITLE_FROM_LOCALE(locale: string): string {
  return templateText(locale, "frame.title");
}
function DEFAULT_INTRO_FROM_LOCALE(locale: string): string {
  return templateText(locale, "frame.intro");
}
function DEFAULT_BUTTON_FROM_LOCALE(locale: string): string {
  return templateText(locale, "frame.button");
}
function DEFAULT_THANKYOU_FROM_LOCALE(locale: string): string {
  return templateText(locale, "frame.thankyou");
}

function buildShowIf(
  template: TemplateDefinition,
  q: TemplateQuestion,
  questions: TemplateQuestion[],
  includedKeys: Set<string>,
  region: RegionPack,
): ShowIf | null {
  if (!q.showIf) return null;
  if (!includedKeys.has(q.showIf.questionKey)) return null;

  // The referenced question's TYPE decides the id space: a yes/no question's
  // options are the fixed `yes`/`no`, not template option ids, so a condition on
  // it must use those ids or the shared validator rejects it.
  const parent = questions.find((candidate) => candidate.key === q.showIf!.questionKey);
  const parentHasFixedOptions = parent?.type === "yes_no" || parent?.type === "satisfaction_5";

  const condition: ShowIf = { questionId: stableQuestionId(template.id, q.showIf.questionKey) };
  if (q.showIf.optionKeys && q.showIf.optionKeys.length > 0) {
    if (parentHasFixedOptions) {
      condition.optionIds = [...q.showIf.optionKeys];
    } else {
      // Resolve the parent's options in this region so a condition never names a
      // pack option the region does not ship (the Global channel pack has no
      // `podcast`, for one). An unresolvable key is simply dropped.
      const available = new Set(questionOptionKeys(parent!, region));
      condition.optionIds = q.showIf.optionKeys
        .filter((key) => available.has(key))
        .map((key) => stableOptionId(template.id, q.showIf!.questionKey, key));
    }
  } else {
    condition.min = q.showIf.min;
    condition.max = q.showIf.max;
  }
  return condition;
}

/** The option keys a template question offers in a region (for show-if checks). */
function questionOptionKeys(q: TemplateQuestion, region: RegionPack): string[] {
  if (q.pack) return packFor(q.pack as PackFamily, region).options.map((o) => o.key);
  if (q.type === "yes_no") return ["yes", "no"];
  if (q.type === "satisfaction_5") {
    return ["very_dissatisfied", "dissatisfied", "neutral", "satisfied", "very_satisfied"];
  }
  return (q.options ?? []).map((o) => o.key);
}

function resolveQuestionOptions(
  template: TemplateDefinition,
  q: TemplateQuestion,
  region: RegionPack,
  locale: string,
  overrides?: Record<string, string>,
): SurveyOptionDef[] {
  if (q.pack) {
    const pack = packFor(q.pack as PackFamily, region);
    return pack.options.map((option) => ({
      id: stableOptionId(template.id, q.key, option.key),
      label: templateText(locale, option.labelKey),
      isOther: option.isOther,
      exclusive: option.exclusive,
    }));
  }

  return (q.options ?? []).map((option) => ({
    id: stableOptionId(template.id, q.key, option.key),
    label: overrides?.[option.key] ?? templateText(locale, option.labelKey),
    isOther: option.isOther,
    exclusive: option.exclusive,
  }));
}

/** The default rating/NPS scale labels for a question, if it has a scale. */
export function questionScaleLabels(
  template: TemplateDefinition,
  q: TemplateQuestion,
): { low: string; high: string } | null {
  if (q.scaleLabelKeys) return { low: q.scaleLabelKeys.low, high: q.scaleLabelKeys.high };
  if (q.type === "nps") return { low: DEFAULT_NPS_SCALE.low, high: DEFAULT_NPS_SCALE.high };
  return null;
}

export { DEFAULT_DESIGN };
