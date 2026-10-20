import {
  formatTimestamp,
  orderAdminLink,
  questionColumnHeader,
  resolveExportTimeZone,
  toAllSurveysTable,
  toSurveyTable,
  type AllSurveysCsvRow,
  type CsvTable,
  type SurveyCsvRow,
} from "~/lib/csv";
import { answerParts } from "~/lib/answer-text";
import type { TFunction } from "~/lib/i18n";
import {
  currentOrderTotal,
  fetchSurveyResponses,
  surveyRevenueStatus,
  type SurveyResponseRow,
} from "~/lib/survey-analytics.server";
import { getSurveyRow, getSurveyRows } from "~/lib/surveys.server";
import { db } from "~/db.server";

/**
 * The survey CSV files, built once for both the download and the Export page's
 * preview, so the preview is the file.
 *
 * - One survey: the wide file, one row per buyer and one column per question.
 * - All surveys: one row per answer, named by survey and question, because
 *   different surveys ask different questions.
 *
 * Revenue status is the Results page's decision (`surveyRevenueStatus`), so the
 * rows marked `counted` are exactly the orders its totals include.
 */

/** Same cap as the channel export; the newest answers are kept. */
export const MAX_SURVEY_CSV_ROWS = 50_000;

export type SurveyExport = CsvTable & {
  /** True when the newest `limit` answers were kept and older ones left out. */
  truncated: boolean;
};

type ExportParams = {
  shopId: string;
  shopDomain: string;
  timeZone: string | null;
  /** Fixed Yes/No and satisfaction labels in the merchant's language. */
  t: TFunction;
  limit?: number;
  /** The file is oldest first; the preview shows the newest answers first. */
  order?: "oldest_first" | "newest_first";
  /** Only answers given in [start, end), when set (the Results page's range). */
  start?: Date;
  end?: Date;
};

type QuestionInfo = { id: string; text: string; type: string };

async function surveyShape(shopId: string, surveyId: string) {
  return shapeOf(await getSurveyRow(shopId, surveyId));
}

function shapeOf(row: Awaited<ReturnType<typeof getSurveyRow>>) {
  const questions: QuestionInfo[] = (row?.questions ?? []).map((q) => ({ id: q.id, text: q.text, type: q.type }));
  const labels = new Map<string, string>();
  for (const question of row?.questions ?? []) {
    for (const option of question.options) labels.set(option.id, option.label);
  }
  return { name: row?.name ?? "", questions, labels };
}

async function loadResponses(params: ExportParams & { surveyId?: string }) {
  const limit = params.limit ?? MAX_SURVEY_CSV_ROWS;
  const fetched = await fetchSurveyResponses({
    shopId: params.shopId,
    ...(params.surveyId ? { surveyId: params.surveyId } : {}),
    ...(params.start ? { start: params.start } : {}),
    ...(params.end ? { end: params.end } : {}),
    limit: limit + 1,
  });
  const truncated = fetched.length > limit;
  // The query is newest first. One row past the cap says whether any was left out.
  const kept = truncated ? fetched.slice(0, limit) : fetched;
  return { responses: params.order === "newest_first" ? kept : [...kept].reverse(), truncated };
}

function orderColumns(response: SurveyResponseRow, shopDomain: string, timeZone: string) {
  const total = currentOrderTotal(response);
  return {
    orderName: response.orderNumber,
    orderId: response.orderId,
    submittedAt: formatTimestamp(response.createdAt, timeZone),
    timeZone,
    placement: response.placement,
    orderTotal: total?.total ?? null,
    currency: total?.currency ?? null,
    revenueStatus: surveyRevenueStatus(response),
    orderLink: response.orderId ? orderAdminLink(shopDomain, response.orderId) : "",
  };
}

/** One survey, one row per buyer. */
export async function buildSurveyExport(params: ExportParams & { surveyId: string }): Promise<SurveyExport> {
  const timeZone = resolveExportTimeZone(params.timeZone);
  const [shape, { responses, truncated }] = await Promise.all([
    surveyShape(params.shopId, params.surveyId),
    loadResponses(params),
  ]);
  const types = new Map(shape.questions.map((q) => [q.id, q.type]));
  const taken = new Set<string>();
  const columns = shape.questions.map((question, index) => ({
    id: question.id,
    header: questionColumnHeader(question.text, index, taken),
  }));

  const rows: SurveyCsvRow[] = responses.map((response) => {
    const answers: Record<string, string> = {};
    for (const answer of response.answers) {
      answers[answer.questionId] = answerParts(answer, types.get(answer.questionId), shape.labels, params.t).join("; ");
    }
    return { ...orderColumns(response, params.shopDomain, timeZone), answers };
  });

  return { ...toSurveyTable(rows, columns), truncated };
}

/** Every survey, one row per answer. */
export async function buildAllSurveysExport(params: ExportParams): Promise<SurveyExport> {
  const timeZone = resolveExportTimeZone(params.timeZone);
  const [surveys, loaded] = await Promise.all([getSurveyRows(params.shopId), loadResponses(params)]);
  // Every survey's questions in one query, not one query per survey.
  const shapes = new Map(surveys.map((survey) => [survey.id, shapeOf(survey)] as const));
  const { responses } = loaded;
  let truncated = loaded.truncated;
  // The cap is on rows, as the header says: one answer set is several rows.
  const maxRows = params.limit ?? MAX_SURVEY_CSV_ROWS;

  // Filled newest first, so the rows the cap keeps are the newest, then put
  // back in the file's order.
  const newestFirst = params.order === "newest_first" ? responses : [...responses].reverse();
  const groups: AllSurveysCsvRow[][] = [];
  let count = 0;
  for (const response of newestFirst) {
    const shape = shapes.get(response.surveyId);
    if (!shape) continue;
    const order = orderColumns(response, params.shopDomain, timeZone);
    const byQuestion = new Map(response.answers.map((answer) => [answer.questionId, answer]));
    const group: AllSurveysCsvRow[] = [];
    // In the survey's question order, so a buyer's answers read top to bottom.
    for (const question of shape.questions) {
      const answer = byQuestion.get(question.id);
      if (!answer) continue;
      group.push({
        ...order,
        surveyName: shape.name,
        question: question.text,
        answer: answerParts(answer, question.type, shape.labels, params.t).join("; "),
      });
    }
    // A buyer's answers are kept together or not at all.
    if (count + group.length > maxRows) {
      truncated = true;
      break;
    }
    count += group.length;
    groups.push(group);
  }
  const rows = (params.order === "newest_first" ? groups : groups.reverse()).flat();

  return { ...toAllSurveysTable(rows), truncated };
}

/**
 * What the Export page downloads: every survey (the default), one survey, or
 * the original channel file. An unknown survey id falls back to every survey
 * rather than to someone else's or to an empty file.
 */
export type ExportSelection = { kind: "all" } | { kind: "channels" } | { kind: "survey"; surveyId: string };

export function parseExportSelection(
  value: string | null,
  surveys: ReadonlyArray<{ id: string }>,
): ExportSelection {
  if (value === "channels") return { kind: "channels" };
  const survey = value ? surveys.find((candidate) => candidate.id === value) : undefined;
  return survey ? { kind: "survey", surveyId: survey.id } : { kind: "all" };
}

export function selectionValue(selection: ExportSelection): string {
  return selection.kind === "survey" ? selection.surveyId : selection.kind;
}

/** Answers a survey file will contain: one survey's, or every survey's. */
export async function countSurveyResponses(shopId: string, surveyId?: string): Promise<number> {
  return db.response.count({ where: { shopId, ...(surveyId ? { surveyId } : {}) } });
}
