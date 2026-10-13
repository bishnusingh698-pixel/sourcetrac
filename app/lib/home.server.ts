/**
 * The minimal Home data (T16): up to three active surveys, each with one key
 * number and a confidence label, plus one rule-based next step.
 *
 * Kept separate from the dashboard loader so the Home screen's cost is bounded:
 * it reads at most three surveys' responses and computes the same main-question
 * stats the Results tab uses. Nothing here is shown for a shop with no surveys —
 * the setup guide handles that case instead.
 */

import { db } from "~/db.server";
import { buildSurveyInsights } from "~/lib/insights.server";
import { fetchSurveyResponses } from "~/lib/survey-analytics.server";
import { listSurveys } from "~/lib/surveys.server";

export type HomeSurvey = {
  id: string;
  name: string;
  /** One key number: the top answer's label and share, or a numeric mean. */
  keyNumber: string;
  confidence: string;
  responseCount: number;
  hasDraft: boolean;
};

/** At most three active surveys get a row on Home. */
const HOME_SURVEY_LIMIT = 3;

export async function loadHomeSurveys(shopId: string, locale: string): Promise<HomeSurvey[]> {
  const surveys = (await listSurveys(shopId)).filter((s) => s.status === "active").slice(0, HOME_SURVEY_LIMIT);
  if (surveys.length === 0) return [];

  const out: HomeSurvey[] = [];
  for (const item of surveys) {
    const row = await db.survey.findFirst({
      where: { id: item.id, shopId },
      include: { questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } } },
    });
    if (!row) continue;

    const responses = await fetchSurveyResponses({ shopId, surveyId: item.id, limit: 5000 });
    const insights = buildSurveyInsights({
      responses,
      questions: row.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.options })),
      templateId: row.templateId,
      locale,
    });

    const main = insights.main;
    const keyNumber = main
      ? main.average !== null
        ? String(main.average)
        : main.topOptionKey
          ? `${insights.optionLabels[main.topOptionKey] ?? main.topOptionKey} · ${Math.round(main.topShare * 100)}%`
          : "—"
      : "—";

    out.push({
      id: item.id,
      name: item.name,
      keyNumber,
      confidence: main?.confidence ?? "too_early",
      responseCount: item.responseCount,
      hasDraft: row.draft !== null,
    });
  }
  return out;
}
