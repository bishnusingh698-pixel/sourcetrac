import { db } from "~/db.server";
import { logger } from "~/lib/logger";
import { shopifyGraphql } from "~/lib/shopify-graphql.server";

/**
 * Look up the survey answer a merchant's admin block should show (Phase 7).
 *
 * The id in the request is only a lookup key; the caller has already verified
 * the ID token and resolved the shop, so this never takes a shop domain from
 * the caller.
 *
 * An order can have at most one Response per survey; a customer can have many,
 * so the customer path takes the most recent answer across their orders. Only
 * the channel label and a couple of display fields are returned. The free-text
 * "Other" answer is the buyer's answer to the survey question itself, so it is
 * shown; no customer name, email, phone or address is ever read or returned.
 */

export type AdminSurveyContext = {
  found: boolean;
  channel: string | null;
  channelLabel: string | null;
  surveyName: string | null;
  submittedAt: string | null;
};

const EMPTY: AdminSurveyContext = {
  found: false,
  channel: null,
  channelLabel: null,
  surveyName: null,
  submittedAt: null,
};

async function resolveChannelLabel(
  _shopId: string,
  answer: { questionId: string; optionIds: string; otherText: string | null },
): Promise<string | null> {
  const optionIds = safeArray(answer.optionIds);
  const first = optionIds[0];
  let label = answer.otherText ?? null;
  if (!label && first) {
    // Option has no shopId. Scope the lookup to the answer's own question (the
    // response was already scoped to the shop), so an id that is not globally
    // unique - a backfilled channel value, a template key - cannot resolve to
    // another shop's label.
    const option = await db.option.findFirst({
      where: { id: first, questionId: answer.questionId },
      select: { label: true },
    });
    label = option?.label ?? first;
  }
  return label;
}

function safeArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The newest of these responses that answered its survey's channel question.
 * The block says "How they heard about us", so only that question's answer may
 * fill it: a gift, price or NPS answer (the old fallback to whichever answer
 * came first) would tell the merchant something false.
 */
async function channelContext(
  shopId: string,
  where: { orderId: string } | { orderId: { in: string[] } },
): Promise<AdminSurveyContext> {
  const responses = await db.response.findMany({
    where: { shopId, ...where, survey: { channelReportQuestionId: { not: null } } },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      survey: { select: { name: true, channelReportQuestionId: true } },
      answers: true,
    },
  });
  for (const response of responses) {
    const answer = response.answers.find((a) => a.questionId === response.survey.channelReportQuestionId);
    if (!answer) continue;
    const channelLabel = await resolveChannelLabel(shopId, answer);
    if (!channelLabel) continue;
    return {
      found: true,
      channel: safeArray(answer.optionIds)[0] ?? answer.otherText ?? null,
      channelLabel,
      surveyName: response.survey.name,
      submittedAt: response.createdAt.toISOString(),
    };
  }
  return EMPTY;
}

export async function lookupByOrder(shopId: string, orderId: string): Promise<AdminSurveyContext> {
  return channelContext(shopId, { orderId });
}

const CUSTOMER_ORDERS = `#graphql
  query SourceTracCustomerOrders($query: String!) {
    orders(first: 100, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes { id }
    }
  }
`;

/**
 * Customer lookup: a customer has many orders, so read the orders attributed to
 * them and pick the newest answer among those.
 *
 * Deliberately queries `orders(query: "customer_id:…")` rather than
 * `customer(id:)`: the app holds only `read_orders`, and the `customer` query
 * would need `read_customers`, which we neither request nor want. Without
 * `read_all_orders` Shopify returns only about the last 60 days of orders, so
 * the block says it looked at recent orders. A failed GraphQL read throws, so
 * the block says it could not check rather than "no answer".
 */
export async function lookupByCustomer(params: {
  shopId: string;
  shopDomain: string;
  accessToken: string;
  customerGid: string;
}): Promise<AdminSurveyContext> {
  const numericCustomer = params.customerGid.match(/(\d+)$/)?.[1];
  if (!numericCustomer) return EMPTY;

  let orderIds: string[] = [];
  try {
    const result = await shopifyGraphql<{ orders: { nodes: Array<{ id: string }> } }>(
      params.shopDomain,
      params.accessToken,
      CUSTOMER_ORDERS,
      { query: `customer_id:${numericCustomer}` },
    );
    orderIds = (result.data.orders.nodes ?? [])
      .map((node) => node.id.match(/(\d+)$/)?.[1])
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    logger.warn("admin_context_customer_orders_failed", {
      shop_id: params.shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (orderIds.length === 0) return EMPTY;

  return channelContext(params.shopId, { orderId: { in: orderIds } });
}

