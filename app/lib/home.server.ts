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
  /** One key number: the top answer's label and share, a mean, or an NPS score. */
  keyNumber: string;
  confidence: string;
  /** The answers the confidence label was computed from (the badge's n). */
  responseCount: number;
  hasDraft: boolean;
};

/** At most three active surveys get a row on Home. */
const HOME_SURVEY_LIMIT = 3;
/** Newest answers read per survey for its key number; Results has the full view. */
const HOME_RESPONSE_LIMIT = 2_000;

/**
 * Whether this shop has ever collected an answer.
 *
 * Both tables must be checked: the single-question extension wrote
 * `SurveyResponse`, but the multi-question extension writes only `Response`.
 * Checking the legacy table alone left a merchant whose answers are all v2
 * staring at the setup guide forever.
 */
export async function hasAnyResponse(shopId: string): Promise<boolean> {
  const [legacy, v2] = await Promise.all([
    db.surveyResponse.findFirst({ where: { shopId }, select: { id: true } }),
    db.response.findFirst({ where: { shopId }, select: { id: true } }),
  ]);
  return legacy !== null || v2 !== null;
}

export async function loadHomeSurveys(shopId: string, locale: string): Promise<HomeSurvey[]> {
  const surveys = (await listSurveys(shopId)).filter((s) => s.status === "active").slice(0, HOME_SURVEY_LIMIT);
  if (surveys.length === 0) return [];

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });

  // In parallel: each survey is independent, and serial reads made Home wait
  // for all of them back to back.
  const rows = await Promise.all(surveys.map((item) => loadOne(item)));
  return rows.filter((row): row is HomeSurvey => row !== null);

  async function loadOne(item: (typeof surveys)[number]): Promise<HomeSurvey | null> {
    const row = await db.survey.findFirst({
      where: { id: item.id, shopId },
      include: { questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } } },
    });
    if (!row) return null;

    const responses = await fetchSurveyResponses({ shopId, surveyId: item.id, limit: HOME_RESPONSE_LIMIT });
    const insights = buildSurveyInsights({
      responses,
      questions: row.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.options })),
      templateId: row.templateId,
      locale,
    });

    const main = insights.main;
    let keyNumber = "—";
    if (main?.nps) {
      // An NPS question's headline is the score (% promoters − % detractors),
      // not the 0–10 mean.
      keyNumber = number.format(Math.round((main.nps.promoter - main.nps.detractor) * 100));
    } else if (main && main.average !== null) {
      keyNumber = number.format(main.average);
    } else if (main?.topOptionKey) {
      keyNumber = `${insights.optionLabels[main.topOptionKey] ?? main.topOptionKey} · ${percent.format(main.topShare)}`;
    }

    return {
      id: item.id,
      name: item.name,
      keyNumber,
      confidence: main?.confidence ?? "too_early",
      // The confidence label is computed from the main question's answers, so
      // the badge shows that count, not the survey's lifetime total.
      responseCount: main?.n ?? 0,
      hasDraft: row.draft !== null,
    };
  }
}
