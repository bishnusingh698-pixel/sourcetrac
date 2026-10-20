import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { channelCountsForShop } from "~/lib/analytics-queries.server";
import { findShopByDomain, lastKnownInstalledAt } from "~/lib/shop.server";

/**
 * GDPR / CCPA mandatory webhook handlers.
 *
 * Source: https://shopify.dev/docs/apps/build/privacy-law-compliance
 *
 * SourceTrac deliberately stores no customer-identifying data. A response has
 * shop_id, order_id, channel, timestamp and nothing else — no email, no name,
 * no address, no customer GID, even when the session token carried a `sub`
 * claim. That is what makes these handlers correct and short.
 *
 * A data_export job is only required when you hold personal data. We still
 * export the order IDs we associate with a customer, because that is the only
 * thing we hold about them, and answering accurately is better than arguing
 * the boundary with a compliance officer.
 */

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

export type DataRequestRecord = {
  orderId: string;
  submittedAt: string;
  /** Question text -> the answer as the buyer gave it (option label or text). */
  answers: Array<{ question: string; answer: string }>;
  /** What the checkout reported with the answer (country, language, products, first order). */
  details?: Record<string, string>;
};

/** Everything else held for one named order, outside the answers. */
export type DataRequestOrderData = {
  orderId: string;
  /** From the order webhook: total, currency, status, dates. */
  order?: Record<string, string>;
  /** The first-order flag the Thank-you page reported. */
  isFirstOrder?: boolean;
  /** Checkout page loads recorded for "Recent checkouts". */
  checkoutLoads?: Array<{ at: string; page: string; country: string | null; outcome: string }>;
};

export type DataRequestResult = {
  shopFound: boolean;
  /** Orders Shopify named that we hold survey answers for. */
  ordersFound: string[];
  records: DataRequestRecord[];
  orderData: DataRequestOrderData[];
  note: string;
};

/**
 * customers/data_request — report the data held about one customer.
 *
 * We hold no customer contact details, but Shopify names the customer's orders
 * in `orders_requested`, and answers are stored per order. Those answers
 * (including any free text the buyer typed) ARE this customer's data, so they
 * are reported in full for the merchant to pass on. Other buyers' answers are
 * never included. A shop-level summary is kept alongside for context.
 */
export async function handleDataRequest(params: {
  shopDomain: string;
  customerEmail?: string;
  customerPhone?: string;
  orderIds?: string[];
  /** The delivery's id; a retried delivery does not record a second request. */
  webhookId?: string;
}): Promise<DataRequestResult> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return { shopFound: false, ordersFound: [], records: [], orderData: [], note: "No SourceTrac installation for this shop." };
  }

  const requested = [...new Set(params.orderIds ?? [])];
  const records = requested.length > 0 ? await recordsForOrders(shop.id, requested) : [];
  const orderData = requested.length > 0 ? await orderDataFor(shop.id, requested) : [];

  const [responseCount, v2ResponseCount, orderCount, channels] = await Promise.all([
    retryDb(() => db.surveyResponse.count({ where: { shopId: shop.id } })),
    retryDb(() => db.response.count({ where: { shopId: shop.id } })),
    retryDb(() => db.orderCache.count({ where: { shopId: shop.id } })),
    // Both answer stores: the checkout blocks write only the v2 model.
    channelCountsForShop(shop.id),
  ]);

  logger.info("compliance_data_request", {
    shop_id: shop.id,
    response_count: responseCount + v2ResponseCount,
    requested_orders: requested.length,
    records_found: records.length,
    // Logged for the audit trail only; the values are never stored.
    has_email: Boolean(params.customerEmail),
    has_phone: Boolean(params.customerPhone),
  });

  const breakdown = channels.map((c) => `${c.label}: ${c.count}`).join(", ");
  const ordersFound = [...new Set(records.map((record) => record.orderId))];

  const note =
    (records.length > 0
      ? `For the ${requested.length} order(s) Shopify named, SourceTrac holds ${records.length} survey ` +
        `response(s) (orders ${ordersFound.join(", ")}); every answer is listed in this request. `
      : requested.length > 0
        ? `SourceTrac holds no survey answers for the ${requested.length} order(s) Shopify named. `
        : "") +
    "SourceTrac stores no customer contact details (no name, email, phone or address) and no customer ID. " +
    `For this shop we hold ${responseCount + v2ResponseCount} survey response(s) across ${orderCount} cached order(s)` +
    (breakdown ? `, by channel: ${breakdown}.` : ".");

  // Record the request so the merchant can see (and pass on) what was found.
  // The stored payload is the export, never the buyer's identifiers.
  const alreadyRecorded =
    params.webhookId !== undefined &&
    (await retryDb(() =>
      db.dataRequest.findFirst({
        where: { shopId: shop.id, payload: { contains: `"webhookId":${JSON.stringify(params.webhookId)}` } },
        select: { id: true },
      }),
    )) !== null;
  if (!alreadyRecorded) {
    await retryDb(() =>
      db.dataRequest.create({
        data: {
          shopId: shop.id,
          customerId: null,
          payload: JSON.stringify({
            webhookId: params.webhookId ?? null,
            note,
            responseCount: responseCount + v2ResponseCount,
            orderCount,
            records,
            orderData,
          }),
        },
      }),
    );
  }

  return { shopFound: true, ordersFound, records, orderData, note };
}

/**
 * The order-level data held for the named orders besides the answers: the
 * cached order, the Thank-you page's first-order flag and the checkout loads
 * listed under "Recent checkouts".
 */
async function orderDataFor(shopId: string, orderIds: string[]): Promise<DataRequestOrderData[]> {
  const scope = { shopId, orderId: { in: orderIds } };
  const [orders, facts, loads] = await Promise.all([
    retryDb(() =>
      db.orderCache.findMany({
        where: scope,
        select: {
          orderId: true,
          orderNumber: true,
          totalPrice: true,
          currency: true,
          financialStatus: true,
          isTest: true,
          isCancelled: true,
          sourceName: true,
          createdAtShop: true,
        },
      }),
    ),
    retryDb(() => db.orderFact.findMany({ where: scope, select: { orderId: true, isFirstOrder: true } })),
    retryDb(() =>
      db.checkoutLoad.findMany({
        where: scope,
        orderBy: { at: "asc" },
        select: { orderId: true, at: true, placement: true, country: true, reason: true },
      }),
    ),
  ]);
  const byOrder = new Map<string, DataRequestOrderData>();
  const entry = (orderId: string) => {
    const existing = byOrder.get(orderId);
    if (existing) return existing;
    const created: DataRequestOrderData = { orderId };
    byOrder.set(orderId, created);
    return created;
  };
  for (const order of orders) {
    entry(order.orderId).order = {
      order: order.orderNumber ?? order.orderId,
      total: order.totalPrice?.toString() ?? "",
      currency: order.currency,
      financialStatus: order.financialStatus ?? "",
      test: String(order.isTest),
      cancelled: String(order.isCancelled),
      source: order.sourceName ?? "",
      placedAt: order.createdAtShop.toISOString(),
    };
  }
  for (const fact of facts) entry(fact.orderId).isFirstOrder = fact.isFirstOrder;
  for (const load of loads) {
    if (!load.orderId) continue;
    const data = entry(load.orderId);
    (data.checkoutLoads ??= []).push({
      at: load.at.toISOString(),
      page: load.placement,
      country: load.country,
      outcome: load.reason,
    });
  }
  return [...byOrder.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
}

/** Every answer stored for the given orders, legacy and v2, oldest first. */
async function recordsForOrders(shopId: string, orderIds: string[]): Promise<DataRequestRecord[]> {
  const [legacy, v2, labels] = await Promise.all([
    retryDb(() =>
      db.surveyResponse.findMany({
        where: { shopId, orderId: { in: orderIds } },
        select: { id: true, orderId: true, channel: true, otherText: true, submittedAt: true },
      }),
    ),
    retryDb(() =>
      db.response.findMany({
        where: { shopId, orderId: { in: orderIds } },
        select: {
          id: true,
          orderId: true,
          createdAt: true,
          country: true,
          locale: true,
          productIds: true,
          isFirstOrder: true,
          answers: {
            select: {
              optionIds: true,
              numberValue: true,
              textValue: true,
              otherText: true,
              question: { select: { text: true, options: { select: { id: true, label: true } } } },
            },
          },
        },
      }),
    ),
    retryDb(() => db.shop.findUnique({ where: { id: shopId }, select: { questionText: true } })),
  ]);
  const migrated = new Set(v2.map((row) => row.id));

  const records: DataRequestRecord[] = [];
  for (const row of legacy) {
    if (migrated.has(`bf-response-${row.id}`)) continue;
    records.push({
      orderId: row.orderId,
      submittedAt: row.submittedAt.toISOString(),
      answers: [{ question: labels?.questionText ?? "", answer: [row.channel, row.otherText].filter(Boolean).join(": ") }],
    });
  }
  for (const row of v2) {
    const details: Record<string, string> = {};
    if (row.country) details.country = row.country;
    if (row.locale) details.language = row.locale;
    const products = safeIds(row.productIds ?? "[]");
    if (products.length > 0) details.products = products.join(", ");
    if (row.isFirstOrder !== null) details.firstOrder = String(row.isFirstOrder);
    records.push({
      orderId: row.orderId ?? "",
      submittedAt: row.createdAt.toISOString(),
      ...(Object.keys(details).length > 0 ? { details } : {}),
      answers: row.answers.map((answer) => {
        const labelOf = new Map(answer.question.options.map((option) => [option.id, option.label]));
        const parts: string[] = [];
        for (const id of safeIds(answer.optionIds)) parts.push(labelOf.get(id) ?? id);
        if (typeof answer.numberValue === "number") parts.push(String(answer.numberValue));
        if (answer.textValue) parts.push(answer.textValue);
        if (answer.otherText) parts.push(answer.otherText);
        return { question: answer.question.text, answer: parts.join("; ") };
      }),
    });
  }
  return records.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

function safeIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * customers/redact — delete data linked to the given orders within 10 days.
 *
 * We hold no customer contact details, so we cannot find a buyer's rows by
 * email or phone. We do not need to: Shopify tells us exactly which orders to
 * redact in `orders_to_redact`, and `SurveyResponse.orderId` /
 * `OrderCache.orderId` store `String(order.id)` from the REST payload — the
 * same numeric ID that appears in that array. The join is exact.
 *
 * Deleting only these rows is what the requirement asks for. Wiping the whole
 * shop would destroy other buyers' answers, which it does not.
 *
 * A redact can name thousands of orders for a busy store, which will not finish
 * inside the webhook's 5-second budget. Past `REDACT_BATCH_SIZE` the request is
 * recorded in `PendingDeletion` and only the first batch runs inline; the rest
 * is drained lazily by `processPendingDeletions`, so the webhook stays fast and
 * Shopify never sees a timeout.
 */
export async function handleCustomerRedact(params: {
  shopDomain: string;
  orderIds: string[];
  /** The delivery's id; a retried delivery does not queue the work twice. */
  webhookId?: string;
}): Promise<{ shopFound: boolean; deletedResponses: number; deletedOrders: number; deletedV2Responses: number; deferred: boolean }> {
  const shop = await findShopByDomain(params.shopDomain);

  if (!shop) {
    return { shopFound: false, deletedResponses: 0, deletedOrders: 0, deletedV2Responses: 0, deferred: false };
  }

  const orderIds = [...new Set(params.orderIds)];
  if (orderIds.length === 0) {
    // Shopify sends an empty array when it holds no order link for this
    // customer. Nothing of ours is attributable, so there is nothing to delete.
    logger.info("compliance_customer_redact_empty", { shop_id: shop.id });
    return { shopFound: true, deletedResponses: 0, deletedOrders: 0, deletedV2Responses: 0, deferred: false };
  }

  // Remember every named order first, so nothing about them is stored again
  // (a later orders/updated, a late answer) while the deletion runs.
  for (let i = 0; i < orderIds.length; i += 1000) {
    const chunk = orderIds.slice(i, i + 1000);
    await retryDb(() =>
      db.redactedOrder.createMany({ data: chunk.map((orderId) => ({ shopId: shop.id, orderId })), skipDuplicates: true }),
    );
    // The first-order flag the Thank-you page reported for these orders.
    await retryDb(() => db.orderFact.deleteMany({ where: { shopId: shop.id, orderId: { in: chunk } } }));
  }

  if (orderIds.length > REDACT_BATCH_SIZE) {
    // The first batch inline, then the rest queued. Queued after the inline
    // pass (and once per delivery), so a retried webhook does not queue the
    // same work twice.
    const first = await deleteOrdersForShop(shop.id, orderIds.slice(0, REDACT_BATCH_SIZE));
    const remaining = orderIds.slice(REDACT_BATCH_SIZE);
    const queued =
      params.webhookId !== undefined &&
      (await retryDb(() =>
        db.pendingDeletion.findFirst({
          where: { shopId: shop.id, payload: { contains: `"webhookId":${JSON.stringify(params.webhookId)}` } },
          select: { id: true },
        }),
      )) !== null;
    if (!queued) {
      await retryDb(() =>
        db.pendingDeletion.create({
          data: {
            shopId: shop.id,
            scope: "customer",
            payload: JSON.stringify({ orderIds: remaining, webhookId: params.webhookId ?? null }),
          },
        }),
      );
    }
    logger.info("compliance_customer_redact_deferred", {
      shop_id: shop.id,
      orders: orderIds.length,
      remaining: remaining.length,
    });
    // Drain the rest right after this response, not on the merchant's next
    // dashboard visit (which may be after Shopify's 30-day deadline).
    startPendingDeletions(shop.id);
    return { shopFound: true, ...first, deferred: true };
  }

  const deleted = await deleteOrdersForShop(shop.id, orderIds);
  return { shopFound: true, ...deleted, deferred: false };
}

/** Orders a redact may delete inline before the work is deferred. */
export const REDACT_BATCH_SIZE = 200;

/**
 * Delete the rows Shopify named. v2 responses go first (their Answers cascade
 * and their PendingSync rows would otherwise be orphaned), then the legacy
 * responses, then the order cache — which must not outlive the responses whose
 * totals were reconciled from it.
 */
async function deleteOrdersForShop(
  shopId: string,
  orderIds: string[],
): Promise<{ deletedResponses: number; deletedOrders: number; deletedV2Responses: number }> {
  if (orderIds.length === 0) return { deletedResponses: 0, deletedOrders: 0, deletedV2Responses: 0 };
  const scope = { shopId, orderId: { in: orderIds } };

  const v2Rows = await retryDb(() => db.response.findMany({ where: scope, select: { id: true, createdAt: true } }));
  const legacyRows = await retryDb(() => db.surveyResponse.findMany({ where: scope, select: { submittedAt: true } }));
  const v2ResponseIds = v2Rows.map((row) => row.id);
  const redactedDays = [
    ...new Set([
      ...v2Rows.map((row) => row.createdAt.toISOString().slice(0, 10)),
      ...legacyRows.map((row) => row.submittedAt.toISOString().slice(0, 10)),
    ]),
  ];
  if (v2ResponseIds.length > 0) {
    await retryDb(() => db.pendingSync.deleteMany({ where: { shopId, responseId: { in: v2ResponseIds } } }));
  }
  const deletedV2Responses = (await retryDb(() => db.response.deleteMany({ where: scope }))).count;
  const deletedOrders = (await retryDb(() => db.orderCache.deleteMany({ where: scope }))).count;
  // "Recent checkouts" rows name the order and its country.
  await retryDb(() => db.checkoutLoad.deleteMany({ where: scope }));
  const deletedResponses = (await retryDb(() => db.surveyResponse.deleteMany({ where: scope }))).count;

  // A submit landing between the read above and the delete leaves a sync row
  // with no response (PendingSync has no foreign key to cascade it).
  await retryDb(
    () => db.$executeRaw`
      DELETE FROM "PendingSync" p
      WHERE p."shopId" = ${shopId}
        AND NOT EXISTS (SELECT 1 FROM "Response" r WHERE r.id = p."responseId")
    `,
  );
  // A data-request export stored before this redact holds these orders'
  // answers verbatim (free text included); it must not outlive the redact.
  await scrubDataRequests(shopId, orderIds);

  // SurveyDailyStats aggregates per day and channel, so a day's bucket can
  // describe a single order. Remove the buckets of the days the redacted
  // answers were given on; other days are untouched.
  if (redactedDays.length > 0) {
    await retryDb(() => db.surveyDailyStats.deleteMany({ where: { shopId, day: { in: redactedDays } } }));
  }

  logger.info("compliance_customer_redact", {
    shop_id: shopId,
    requested_orders: orderIds.length,
    deleted_responses: deletedResponses,
    deleted_v2_responses: deletedV2Responses,
    deleted_orders: deletedOrders,
  });

  return { deletedResponses, deletedOrders, deletedV2Responses };
}

/** Remove the named orders from every stored data-request export of the shop. */
async function scrubDataRequests(shopId: string, orderIds: string[]): Promise<void> {
  const redacted = new Set(orderIds);
  const requests = await retryDb(() =>
    db.dataRequest.findMany({ where: { shopId }, select: { id: true, payload: true } }),
  );
  for (const request of requests) {
    let payload: { records?: DataRequestRecord[]; orderData?: DataRequestOrderData[]; note?: string } & Record<string, unknown>;
    try {
      payload = JSON.parse(request.payload) as typeof payload;
    } catch {
      continue;
    }
    const records = (payload.records ?? []).filter((record) => !redacted.has(record.orderId));
    const orderData = (payload.orderData ?? []).filter((data) => !redacted.has(data.orderId));
    if (records.length === (payload.records ?? []).length && orderData.length === (payload.orderData ?? []).length) continue;
    const scrubbed = {
      ...payload,
      records,
      orderData,
      // The note names the orders it found; it is rewritten rather than kept.
      note: "Some orders in this request were later redacted at the customer's request; their data was deleted.",
    };
    await retryDb(() => db.dataRequest.update({ where: { id: request.id }, data: { payload: JSON.stringify(scrubbed) } }));
  }
}

/** One drain per shop at a time. */
const deletionsInFlight = new Map<string, Promise<void>>();

/**
 * Drain deferred redacts for one shop, a batch at a time. Each pass removes the
 * orders it deleted from the stored payload, so a crash mid-batch resumes rather
 * than restarting, and the row is dropped once nothing is left.
 */
export function processPendingDeletions(shopId: string, maxBatches = 5): Promise<{ processed: number; remaining: number }> {
  // One drainer per shop in this process: the dashboard, the webhook kick and
  // the redact's own background drain used to work the same row at once.
  const running = deletionsInFlight.get(shopId);
  if (running) return running.then(() => ({ processed: 0, remaining: 0 }));
  const run = drainPendingDeletions(shopId, maxBatches);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  deletionsInFlight.set(shopId, settled);
  void settled.finally(() => {
    if (deletionsInFlight.get(shopId) === settled) deletionsInFlight.delete(shopId);
  });
  return run;
}

async function drainPendingDeletions(shopId: string, maxBatches: number): Promise<{ processed: number; remaining: number }> {
  let processed = 0;
  let remaining = 0;

  const pending = await retryDb(() =>
    db.pendingDeletion.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } }),
  );

  for (const row of pending) {
    let parsed: { orderIds?: unknown; webhookId?: unknown };
    try {
      parsed = JSON.parse(row.payload) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (!Array.isArray(parsed.orderIds)) {
      // The row is our own writing, so this should never happen; if it does,
      // the deletion obligation is kept (and shouted about), never dropped.
      logger.error("compliance_deferred_redact_unreadable", { shop_id: shopId, pending_deletion_id: row.id });
      continue;
    }
    let orderIds = parsed.orderIds.filter((id): id is string => typeof id === "string");
    const webhookId = parsed.webhookId ?? null;

    let batches = 0;
    while (orderIds.length > 0 && batches < maxBatches) {
      const batch = orderIds.slice(0, REDACT_BATCH_SIZE);
      await deleteOrdersForShop(shopId, batch);
      orderIds = orderIds.slice(REDACT_BATCH_SIZE);
      processed += batch.length;
      batches += 1;
      // Saved after every batch, so a restart resumes instead of starting over.
      if (orderIds.length > 0) {
        await retryDb(() =>
          // Keep the delivery id: a retried webhook must still find this row.
          db.pendingDeletion.updateMany({ where: { id: row.id }, data: { payload: JSON.stringify({ orderIds, webhookId }) } }),
        );
      }
    }

    if (orderIds.length === 0) {
      await retryDb(() => db.pendingDeletion.deleteMany({ where: { id: row.id } }));
    } else {
      remaining += orderIds.length;
    }
  }

  return { processed, remaining };
}

/** Per shop: one process-wide timestamp let one shop's visit skip every other shop's drain. */
const lastDeletionSweep = new Map<string, number>();
const DELETION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Drain a shop's deferred redacts in the background, never throwing. */
export function startPendingDeletions(shopId: string): void {
  if (deletionsInFlight.has(shopId)) return;
  // Every queued batch, not a few: this runs off the request path.
  processPendingDeletions(shopId, Number.POSITIVE_INFINITY).catch((error: unknown) => {
    logger.warn("compliance_deferred_redact_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Drain every shop's deferred redacts. Run from the webhook route and the
 * retention job, so a redact completes whether or not its merchant ever opens
 * the app again. Throttled, and never throws.
 */
let lastGlobalDeletionSweep: number | undefined;

export async function maybeRunAllPendingDeletions(): Promise<void> {
  const now = Date.now();
  if (lastGlobalDeletionSweep !== undefined && now - lastGlobalDeletionSweep < DELETION_SWEEP_INTERVAL_MS) return;
  lastGlobalDeletionSweep = now;
  try {
    const shops = await retryDb(() =>
      db.pendingDeletion.findMany({ distinct: ["shopId"], select: { shopId: true } }),
    );
    for (const { shopId } of shops) startPendingDeletions(shopId);
  } catch (error) {
    lastGlobalDeletionSweep = undefined;
    logger.warn("compliance_deferred_redact_sweep_failed", {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Drain deferred redacts at most once per few minutes per shop, never throwing. */
export async function maybeRunPendingDeletions(shopId: string): Promise<void> {
  const now = Date.now();
  const last = lastDeletionSweep.get(shopId);
  if (last !== undefined && now - last < DELETION_SWEEP_INTERVAL_MS) return;
  if (lastDeletionSweep.size > 10_000) lastDeletionSweep.clear();
  lastDeletionSweep.set(shopId, now);
  try {
    const result = await processPendingDeletions(shopId);
    if (result.processed > 0 || result.remaining > 0) {
      logger.info("compliance_deferred_redact_drained", {
        shop_id: shopId,
        processed: result.processed,
        remaining: result.remaining,
      });
    }
  } catch (error) {
    lastDeletionSweep.delete(shopId);
    logger.warn("compliance_deferred_redact_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * shop/redact — delete all shop data within 48 hours of uninstall request.
 * This is the handler that actually deletes.
 */
export async function handleShopRedact(params: {
  shopDomain: string;
  shopId?: string;
  /** X-Shopify-Triggered-At of the delivery. */
  triggeredAt?: Date | null;
}): Promise<{ shopFound: boolean; deleted: boolean }> {
  const shop = await findShopByDomain(params.shopDomain);

  // shop/redact is sent 48 hours after an uninstall. When the app was installed
  // (or granted a token) AFTER that uninstall, the merchant has reinstalled and
  // the request belongs to the previous installation: deleting would wipe their
  // current surveys, answers and live session. A shop still marked installed
  // whose last known install predates the uninstall is redacted as asked. See
  // DECISIONS.md (H20, H1/M3 2026-10-20).
  if (shop && shop.installState === "installed" && reinstalledSinceUninstall(shop, params.triggeredAt ?? null)) {
    logger.warn("compliance_shop_redact_skipped_reinstalled", { shop_id: shop.id, shop_domain: params.shopDomain });
    return { shopFound: true, deleted: false };
  }

  // Sessions hold access tokens (and, for online sessions, a staff member's
  // name and email). They are deleted even when no shop row remains.
  await retryDb(() => db.session.deleteMany({ where: { shop: params.shopDomain } }));

  if (!shop) {
    logger.info("compliance_shop_redact_noop", { shop_domain: params.shopDomain });
    return { shopFound: false, deleted: false };
  }

  // Foreign keys cascade: survey_responses, orders_cache, billing_usage and
  // webhook_events are all removed with the shop row.
  await retryDb(() => db.shop.delete({ where: { id: shop.id } }));

  logger.info("compliance_shop_redact", { shop_id: shop.id, shop_domain: params.shopDomain });
  return { shopFound: true, deleted: true };
}

/**
 * shop/redact follows the uninstall by 48 hours; an hour of slack. Only used
 * when no app/uninstalled was ever recorded for the shop.
 */
const SHOP_REDACT_DELAY_MS = 49 * 60 * 60 * 1000;

function reinstalledSinceUninstall(
  shop: { installedAt: Date | null; authorizedAt: Date | null; uninstallTriggeredAt: Date | null },
  triggeredAt: Date | null,
): boolean {
  const installedAt = lastKnownInstalledAt(shop);
  if (!installedAt) return false;
  // The recorded uninstall time when there is one: a fixed window assumed
  // Shopify always sends shop/redact exactly 48 hours later.
  const uninstalledAt =
    shop.uninstallTriggeredAt ?? (triggeredAt ? new Date(triggeredAt.getTime() - SHOP_REDACT_DELAY_MS) : null);
  if (!uninstalledAt) return false;
  return installedAt.getTime() > uninstalledAt.getTime();
}

/** Whether customers/redact named this order (see `RedactedOrder`). */
export async function isRedactedOrder(shopInternalId: string, orderId: string): Promise<boolean> {
  const row = await retryDb(() =>
    db.redactedOrder.findUnique({
      where: { shopId_orderId: { shopId: shopInternalId, orderId } },
      select: { orderId: true },
    }),
  );
  return row !== null;
}
