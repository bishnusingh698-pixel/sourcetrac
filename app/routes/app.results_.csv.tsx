import type { LoaderFunctionArgs } from "react-router";

import {
  csvFilename,
  questionColumnHeader,
  resolveExportTimeZone,
  toSurveyCsv,
  orderAdminLink,
  formatTimestamp,
  type RevenueStatus,
  type SurveyCsvRow,
} from "~/lib/csv";
import { currentOrderTotal, fetchSurveyResponses, surveyRevenueStatus } from "~/lib/survey-analytics.server";
import { getSurveyRow, listSurveys } from "~/lib/surveys.server";
import { loadExportContext } from "~/lib/export.server";
import { ensureShop } from "~/lib/provision.server";
import { startOrderBackfill } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { answerParts } from "~/lib/answer-text";
import { createTranslator } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";

/**
 * Results CSV download (`/app/results/csv?survey=<id>`).
 *
 * The multi-question counterpart of `/app/export/csv`: fixed columns for the
 * order and revenue decision, then one column per question. Revenue status uses
 * the same decision as the Results page, so `counted` rows are exactly the
 * orders those totals include.
 */
/** Same cap as the main export; the newest answers are kept. */
const MAX_CSV_ROWS = 50_000;

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  startOrderBackfill({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

  const url = new URL(request.url);
  const surveys = await listSurveys(shop.id);
  const requestedId = url.searchParams.get("survey");
  const selectedId = surveys.find((s) => s.id === requestedId)?.id ?? surveys[0]?.id ?? null;

  const context = await loadExportContext(shop, session);

  if (!selectedId) {
    return new Response(toSurveyCsv([], []), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(new Date(), resolveExportTimeZone(context.timeZone))}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const row = await getSurveyRow(shop.id, selectedId);
  const questions = row?.questions ?? [];
  const labels = new Map<string, string>();
  const types = new Map<string, string>();
  for (const question of questions) {
    types.set(question.id, question.type);
    for (const option of question.options) labels.set(option.id, option.label);
  }
  // Fixed Yes/No and satisfaction labels in the merchant's language, as on
  // the Responses page; the merchant's own option labels are already theirs.
  const t = createTranslator(resolveAdminLanguage(request, shop.language, shop.adminLocale));

  const taken = new Set<string>();
  const questionColumns = questions.map((question, index) => ({
    id: question.id,
    header: questionColumnHeader(question.text, index, taken),
  }));

  const fetched = await fetchSurveyResponses({ shopId: shop.id, surveyId: selectedId, limit: MAX_CSV_ROWS + 1 });
  const truncated = fetched.length > MAX_CSV_ROWS;
  const responses = truncated ? fetched.slice(0, MAX_CSV_ROWS) : fetched;

  const rows: SurveyCsvRow[] = [...responses].reverse().map((response) => {
    const status: RevenueStatus = surveyRevenueStatus(response);
    const total = currentOrderTotal(response);

    const answers: Record<string, string> = {};
    for (const answer of response.answers) {
      answers[answer.questionId] = answerParts(answer, types.get(answer.questionId), labels, t).join("; ");
    }

    return {
      orderName: response.orderNumber,
      orderId: response.orderId,
      submittedAt: formatTimestamp(response.createdAt, resolveExportTimeZone(context.timeZone)),
      timeZone: resolveExportTimeZone(context.timeZone),
      placement: response.placement,
      orderTotal: total?.total ?? null,
      currency: total?.currency ?? null,
      revenueStatus: status,
      orderLink: response.orderId ? orderAdminLink(shop.shopDomain, response.orderId) : "",
      answers,
    };
  });

  return new Response(toSurveyCsv(rows, questionColumns), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(new Date(), resolveExportTimeZone(context.timeZone))}"`,
      "X-SourceTrac-Truncated": String(truncated),
      "X-SourceTrac-Row-Limit": String(MAX_CSV_ROWS),
      "Cache-Control": "no-store",
    },
  });
});
