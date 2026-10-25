/**
 * The quick start survey (F1): "How did you hear about us?" with the answers of
 * the merchant's market, ready to go live in one step.
 *
 * Pure (no database, no Shopify), so it is unit-tested directly. The wording
 * comes from the template bundle in the merchant's language, and every other
 * template language is stored as a translation, exactly like a template, so a
 * buyer whose checkout is in German reads German without the merchant doing
 * anything. Brand answers ("Instagram", "LINE") are the same in every language.
 */

import { LIMITS } from "@shared/survey-rules";
import {
  marketForCountry,
  presetLabel,
  presetOptionTemplateKey,
  type PresetOption,
} from "@shared/templates/channel-presets";
import { TEMPLATE_LOCALES, templateText } from "@shared/templates/locales";
import type { SurveyInput } from "~/lib/surveys.server";

export type QuickStartChoice = {
  /** ISO alpha-2: the market whose answers to use. */
  country: string;
  /** Preset answer keys the merchant kept, in the market's order. */
  keys: string[];
  /** Answers the merchant typed in. */
  custom: string[];
  /** Offer "Other" with a text box. */
  allowOther: boolean;
  /** Ask "Which creator or account was it?" after a social app or a creator. */
  followUp: boolean;
};

/** The answers that trigger the creator follow-up, as in the Channel Compass template. */
const FOLLOW_UP_KEYS = new Set(["creator_influencer", "instagram", "youtube", "tiktok", "podcast", "x_twitter", "snapchat", "douyin", "xiaohongshu"]);

const QUESTION_ID = "quick_channel";
const FOLLOW_UP_ID = "quick_creator";

/** Every template language except `locale`, each with a text lookup. */
function otherLocales(locale: string): Array<{ code: string; text: (key: string) => string }> {
  return TEMPLATE_LOCALES.filter((code) => code !== locale).map((code) => ({ code, text: (key: string) => templateText(code, key) }));
}

/** `key` in every other language, leaving out any that reads the same. */
function translated(key: string, locale: string, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { code, text } of otherLocales(locale)) {
    const value = text(key);
    if (value && value !== base) out[code] = value;
  }
  return out;
}

/** The answers the survey will offer, preset ones first, at most the option limit. */
export function quickStartAnswers(choice: QuickStartChoice, locale: string) {
  const market = marketForCountry(choice.country);
  const kept = new Set(choice.keys);
  const text = (key: string) => templateText(locale, key);
  const preset = market.options.filter((option) => kept.has(option.key));
  const seen = new Set<string>();
  const answers: Array<{ key: string | null; label: string; option: PresetOption | null }> = [];
  for (const option of preset) {
    const label = presetLabel(option, text);
    seen.add(label.trim().toLowerCase());
    answers.push({ key: option.key, label, option });
  }
  for (const raw of choice.custom) {
    const label = raw.trim().slice(0, LIMITS.MAX_OPTION_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    answers.push({ key: null, label, option: null });
  }
  return { market, answers: answers.slice(0, LIMITS.MAX_OPTIONS) };
}

export function quickStartSurveyInput(choice: QuickStartChoice, locale: string, status: "active" | "draft"): SurveyInput {
  const lang = TEMPLATE_LOCALES.includes(locale) ? locale : "en";
  const text = (key: string) => templateText(lang, key);
  const { answers } = quickStartAnswers(choice, lang);

  const frame = {
    title: text("frame.title"),
    intro: text("frame.intro"),
    buttonLabel: text("frame.button"),
    thankYouText: text("frame.thankyou"),
  };
  const translations: Record<string, unknown> = {};
  for (const { code, text: other } of otherLocales(lang)) {
    translations[code] = {
      title: other("frame.title"),
      intro: other("frame.intro"),
      buttonLabel: other("frame.button"),
      thankYouText: other("frame.thankyou"),
    };
  }

  const questionTextKey = "templates.channel-compass.q_channel.text";
  const options = answers.map((answer, index) => ({
    // A posted id only for the follow-up condition; the server gives every
    // new option its own id and remaps the condition.
    id: `${QUESTION_ID}_o${index}`,
    label: answer.label,
    isOther: false,
    exclusive: false,
    translations:
      answer.option?.labelKey ? translated(answer.option.labelKey, lang, answer.label) : {},
    templateKey: answer.key ? presetOptionTemplateKey(null, answer.key) : null,
  }));

  const followUpOn = options.filter((_, index) => {
    const key = answers[index]?.key;
    return key !== null && key !== undefined && FOLLOW_UP_KEYS.has(key);
  });

  const questions: SurveyInput["questions"] = [
    {
      id: QUESTION_ID,
      type: "single_choice",
      text: text(questionTextKey),
      translations: Object.fromEntries(
        Object.entries(translated(questionTextKey, lang, text(questionTextKey))).map(([code, value]) => [code, { text: value }]),
      ),
      required: true,
      // The first answer is picked more just for being first; shuffling evens it out.
      randomizeOptions: true,
      allowOther: choice.allowOther,
      options,
    },
  ];
  if (choice.followUp && followUpOn.length > 0) {
    const followKey = "templates.channel-compass.q_creator.text";
    const placeholderKey = "templates.channel-compass.q_creator.placeholder";
    const followTranslations: Record<string, { text: string; placeholder?: string }> = {};
    for (const { code, text: other } of otherLocales(lang)) {
      followTranslations[code] = { text: other(followKey), placeholder: other(placeholderKey) };
    }
    questions.push({
      id: FOLLOW_UP_ID,
      type: "text",
      text: text(followKey),
      placeholder: text(placeholderKey),
      translations: followTranslations,
      required: false,
      showIf: { questionId: QUESTION_ID, optionIds: followUpOn.map((o) => o.id) },
      options: [],
    });
  }

  return {
    name: text("templates.channel-compass.name"),
    status,
    layout: "all",
    ...frame,
    placements: ["thank_you"],
    channelReportQuestionId: QUESTION_ID,
    targeting: {},
    syncOptions: {},
    translations,
    questions,
  };
}
