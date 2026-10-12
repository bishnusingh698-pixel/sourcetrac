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
import { decideSurveyRevenue, fetchSurveyResponses } from "~/lib/survey-analytics.server";
import { getSurveyRow, listSurveys } from "~/lib/surveys.server";
import { formatDecimalForCurrency } from "~/lib/money";
import { loadExportContext } from "~/lib/export.server";
import { ensureShop } from "~/lib/provision.server";
import { backfillMissingOrders } from "~/lib/order-backfill.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Results CSV download (`/app/results/csv?survey=<id>`).
 *
 * The multi-question counterpart of `/app/export/csv`: fixed columns for the
 * order and revenue decision, then one column per question. Revenue status uses
 * the same decision as the Results page, so `counted` rows are exactly the
 * orders those totals include.
 */
const REASON_LABEL: Record<string, RevenueStatus> = {
  test_order: "test order",
  cancelled: "cancelled",
  voided: "voided",
  fully_refunded: "refunded",
  unreconciled: "awaiting order",
  unparseable_total: "total unreadable",
};

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  await backfillMissingOrders({ shopId: shop.id, shopDomain: shop.shopDomain, accessToken: session.accessToken });

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
  for (const question of questions) {
    for (const option of question.options) labels.set(option.id, option.label);
  }

  const taken = new Set<string>();
  const questionColumns = questions.map((question, index) => ({
    id: question.id,
    header: questionColumnHeader(question.text, index, taken),
  }));

  const responses = await fetchSurveyResponses({ shopId: shop.id, surveyId: selectedId });

  const rows: SurveyCsvRow[] = [...responses].reverse().map((response) => {
    const decision = decideSurveyRevenue(response);
    const status: RevenueStatus = decision.included
      ? "counted"
      : REASON_LABEL[decision.reason] ?? "awaiting order";

    const answers: Record<string, string> = {};
    for (const answer of response.answers) {
      const parts: string[] = [];
      for (const optionId of answer.optionIds) parts.push(labels.get(optionId) ?? optionId);
      if (answer.otherText) parts.push(answer.otherText);
      if (typeof answer.numberValue === "number") parts.push(String(answer.numberValue));
      if (answer.textValue) parts.push(answer.textValue);
      answers[answer.questionId] = parts.join("; ");
    }

    return {
      orderName: response.orderNumber,
      orderId: response.orderId,
      submittedAt: formatTimestamp(response.createdAt, resolveExportTimeZone(context.timeZone)),
      timeZone: resolveExportTimeZone(context.timeZone),
      placement: response.placement,
      orderTotal:
        response.orderTotal !== null && response.currency
          ? formatDecimalForCurrency(response.orderTotal, response.currency)
          : null,
      currency: response.currency ?? null,
      revenueStatus: status,
      orderLink: response.orderId ? orderAdminLink(shop.shopDomain, response.orderId) : "",
      answers,
    };
  });

  return new Response(toSurveyCsv(rows, questionColumns), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(new Date(), resolveExportTimeZone(context.timeZone))}"`,
      "Cache-Control": "no-store",
    },
  });
});
