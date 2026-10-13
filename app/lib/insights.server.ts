/**
 * Read-side insights for a survey: the confidence meter (T9), the "ideas to try"
 * cards (T12), the by-product table (T8) and the cross-question view (T14).
 *
 * This module is the only place that joins a survey's stored questions to the
 * pure aggregation in `shared/templates/stats.ts` and the idea rules in
 * `shared/templates/ideas.ts`. It reads already-loaded responses, so the
 * Results tab, Overview and Home share one implementation and no extra queries
 * are issued per render.
 */

import { computeIdeas } from "@shared/templates/ideas";
import { templateById } from "@shared/templates/index";
import { interpolateTemplateText, templateText } from "@shared/templates/locales";
import { stableQuestionId } from "@shared/templates/resolve";
import {
  buildCrossTab,
  buildIdeaStats,
  buildProductBreakdown,
  buildQuestionStats,
  mainQuestion,
  optionLabels,
  type CrossTab,
  type ProductBreakdownRow,
  type QuestionStats,
  type StatsQuestion,
  type StatsResponse,
} from "@shared/templates/stats";

import type { SurveyResponseRow } from "~/lib/survey-analytics.server";

/** Map a stored question to the pure stats shape. Archived options stay in, so
 *  a removed option still appears in results with its past answers. */
export function statsQuestions(
  questions: ReadonlyArray<{ id: string; type: string; options: ReadonlyArray<{ id: string; label: string; archived: boolean }> }>,
): StatsQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    type: q.type,
    options: q.options.map((o) => ({ id: o.id, label: o.label, archived: o.archived })),
  }));
}

function toStatsResponse(row: SurveyResponseRow): StatsResponse {
  return {
    productIds: row.productIds,
    answers: row.answers.map((answer) => ({
      questionId: answer.questionId,
      optionIds: answer.optionIds,
      numberValue: answer.numberValue,
      textValue: answer.textValue,
      otherText: answer.otherText,
    })),
  };
}

export type ResolvedIdeaView = {
  key: string;
  ruleId: string;
  /** Localized, params already filled in. */
  text: string;
  productId?: string;
  basedOn: number;
};

export type SurveyInsights = {
  /** Stats for the main (first distribution) question, or null when there is none. */
  main: (QuestionStats & { questionId: string }) | null;
  /** The main question's text, for the badge's context. */
  mainQuestionText: string | null;
  /** T12 cards, localized with params filled. */
  ideas: ResolvedIdeaView[];
  /** T8 rows, only when the template asks for a product breakdown. */
  byProduct: ProductBreakdownRow[];
  /** T14 pair, only when the template names one and both questions exist. */
  crossTab: CrossTab | null;
  crossRowQuestionId: string | null;
  crossColQuestionId: string | null;
  optionLabels: Record<string, string>;
};

/**
 * Build every insight for one survey from its loaded responses.
 *
 * `productTitles` is only needed when the template asks for a product
 * breakdown; without it the product id is the label.
 */
export function buildSurveyInsights(params: {
  responses: ReadonlyArray<SurveyResponseRow>;
  questions: ReadonlyArray<{ id: string; type: string; text: string; options: ReadonlyArray<{ id: string; label: string; archived: boolean }> }>;
  templateId: string | null;
  locale: string;
  productTitles?: Record<string, string>;
}): SurveyInsights {
  const questions = statsQuestions(params.questions);
  const labels = optionLabels(questions);
  const responses = params.responses.map(toStatsResponse);
  const template = params.templateId ? templateById(params.templateId) : undefined;
  const main = mainQuestion(questions);

  const result: SurveyInsights = {
    main: null,
    mainQuestionText: null,
    ideas: [],
    byProduct: [],
    crossTab: null,
    crossRowQuestionId: null,
    crossColQuestionId: null,
    optionLabels: labels,
  };

  if (main) {
    const stats = buildQuestionStats(responses, main);
    result.main = stats;
    result.mainQuestionText = params.questions.find((q) => q.id === main.id)?.text ?? null;
  }

  // Ideas are shown only for a survey created from a template (T12 scope), and
  // only when its rules are declared.
  if (template && template.ideas.length > 0 && main) {
    const stats = buildIdeaStats({
      responses,
      questions,
      productTitles: params.productTitles,
      byProduct: template.resultsHints?.byProduct === true,
    });
    result.ideas = computeIdeas(stats, template.ideas).map((idea) => ({
      key: idea.key,
      ruleId: idea.ruleId,
      text: interpolateTemplateText(templateText(params.locale, idea.textKey), idea.params),
      productId: idea.productId,
      basedOn: idea.basedOn,
    }));
  }

  if (template?.resultsHints?.byProduct && main) {
    result.byProduct = buildProductBreakdown({
      responses,
      question: main,
      productTitles: params.productTitles ?? {},
    });
  }

  const crossKeys = template?.resultsHints?.crossQuestion;
  if (crossKeys && params.templateId) {
    // `resultsHints.crossQuestion` names template question keys ("q_channel");
    // the stored survey uses the stable id derived from the template id and the
    // key. Resolve through the same helper `buildSurveyDefinition` uses, or the
    // lookup would never match and the view would never appear.
    const [rowKey, colKey] = crossKeys;
    const rowId = stableQuestionId(params.templateId, rowKey);
    const colId = stableQuestionId(params.templateId, colKey);
    const rowQ = questions.find((q) => q.id === rowId);
    const colQ = questions.find((q) => q.id === colId);
    if (rowQ && colQ) {
      result.crossTab = buildCrossTab({ responses, rowQuestion: rowQ, colQuestion: colQ });
      result.crossRowQuestionId = rowQ.id;
      result.crossColQuestionId = colQ.id;
    }
  }

  return result;
}
