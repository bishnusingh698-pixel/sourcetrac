import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { canSync, hasScope, type SyncScope } from "~/lib/scopes.server";
import { getAccessToken, findShopById } from "~/lib/shop.server";
import { shopifyGraphql } from "~/lib/shopify-graphql.server";

/**
 * Optional write-back to Shopify (Phase 7).
 *
 * After a shopper answers, a merchant can ask SourceTrac to tag the order, tag
 * the customer, write an order metafield, and fire a Shopify Flow trigger. These
 * are the only writes the app ever makes, and every one is:
 *
 *   1. Off by default. Nothing runs unless `Survey.syncOptions` is non-empty.
 *   2. Gated at runtime on the *granted* scope, so a store that installed
 *      before the write scopes were requested keeps a fully working survey with
 *      sync simply skipped (see app/lib/scopes.server.ts).
 *   3. Deferred and idempotent. A write that cannot run now (order not created
 *      yet, throttled, transient fault) is recorded in `PendingSync` and retried
 *      lazily; the tags/metafields mutations are naturally idempotent, so a
 *      retry after a partial success is harmless.
 *
 * The buyer's own submit path never blocks on a Shopify write: the route records
 * the pending work and returns; this module does the network call.
 */

/** Per-survey sync configuration, stored in `Survey.syncOptions` as JSON. */
export type SurveySyncOptions = {
  /** Order tags to add, e.g. ["source:instagram"]. */
  orderTags?: string[];
  /** Customer tags to add. */
  customerTags?: string[];
  /** Order metafields to set. */
  metafields?: Array<{ namespace: string; key: string; keyTemplate?: string; type?: string }>;
  /** Fire the app's Flow trigger with the answer. */
  flowTrigger?: boolean;
  /**
   * T13 smart-action preset ids turned on for a template-created survey. Kept
   * verbatim so the per-answer write logic (Phase 7) can build tags from option
   * keys, and so an unknown preset on an old survey is simply ignored rather
   * than silently dropped at save time.
   */
  presets?: string[];
};

export const MAX_SYNC_TAGS = 4;
export const MAX_SYNC_TAG_LENGTH = 40;
const MAX_SYNC_ATTEMPTS = 5;

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

/** Parse and clamp `Survey.syncOptions`. Unknown keys are ignored. */
export function parseSyncOptions(raw: unknown): SurveySyncOptions {
  const source = (raw ?? {}) as Record<string, unknown>;
  const tags = (value: unknown, prefix: string): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().slice(0, MAX_SYNC_TAG_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_SYNC_TAGS)
      .map((v) => (v.includes(":") ? v : `${prefix}:${v}`));
    return cleaned.length > 0 ? cleaned : undefined;
  };

  const metafields = Array.isArray(source.metafields)
    ? source.metafields
        .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
        .map((m) => ({
          namespace: String(m.namespace ?? "sourcetrac").slice(0, 64),
          key: String(m.key ?? "channel").slice(0, 64),
          type: typeof m.type === "string" ? m.type : "single_line_text_field",
        }))
        .slice(0, 4)
    : undefined;

  return {
    orderTags: tags(source.orderTags, "sourcetrac"),
    customerTags: tags(source.customerTags, "sourcetrac"),
    metafields: metafields && metafields.length > 0 ? metafields : undefined,
    flowTrigger: source.flowTrigger === true,
    presets: Array.isArray(source.presets)
      ? source.presets.filter((v): v is string => typeof v === "string").slice(0, 8)
      : undefined,
  };
}

export function hasSyncWork(options: SurveySyncOptions): boolean {
  return Boolean(
    (options.orderTags && options.orderTags.length > 0) ||
      (options.customerTags && options.customerTags.length > 0) ||
      (options.metafields && options.metafields.length > 0) ||
      options.flowTrigger,
  );
}

/** Which PendingSync kinds `syncOptions` requires, in a stable order. */
function requiredKinds(options: SurveySyncOptions): Array<"tags" | "customer" | "metafield" | "flow"> {
  const kinds: Array<"tags" | "customer" | "metafield" | "flow"> = [];
  if (options.orderTags?.length) kinds.push("tags");
  if (options.customerTags?.length) kinds.push("customer");
  if (options.metafields?.length) kinds.push("metafield");
  if (options.flowTrigger) kinds.push("flow");
  return kinds;
}

/**
 * Record the sync work for one answer.
 *
 * Insert-first, and only for kinds not already pending for this response, so the
 * immediate attempt and the lazy sweep cannot both enqueue the same work.
 */
export async function enqueueSync(shopId: string, responseId: string, options: SurveySyncOptions): Promise<void> {
  const kinds = requiredKinds(options);
  if (kinds.length === 0) return;

  const existing = await retryDb(() =>
    db.pendingSync.findMany({ where: { shopId, responseId }, select: { kind: true } }),
  );
  const have = new Set(existing.map((row) => row.kind));

  const toCreate = kinds.filter((kind) => !have.has(kind));
  if (toCreate.length === 0) return;

  await retryDb(() =>
    db.pendingSync.createMany({
      data: toCreate.map((kind) => ({ shopId, responseId, kind })),
    }),
  );
  logger.info("sync_enqueued", { shop_id: shopId, response_id: responseId, kinds: toCreate });
}

// ---------------------------------------------------------------------------
// Shopify mutations
// ---------------------------------------------------------------------------

const TAGS_ADD = `#graphql
  mutation SourceTracTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation SourceTracMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const FLOW_TRIGGER = `#graphql
  mutation SourceTracFlowReceive($handle: String!, $payload: JSON) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { message }
    }
  }
`;

const ORDER_CUSTOMER = `#graphql
  query SourceTracOrderCustomer($id: ID!) {
    order(id: $id) {
      customer { id }
    }
  }
`;

export const FLOW_TRIGGER_HANDLE = "sourcetrac-survey-answered";

type UserErrors = Array<{ message?: string }> | undefined;

function assertNoUserErrors(userErrors: UserErrors, mutation: string): void {
  if (userErrors && userErrors.length > 0) {
    throw new Error(`${mutation} userErrors: ${userErrors.map((e) => e.message ?? "?").join(", ")}`);
  }
}

/** `gid://shopify/Order/<n>` from the numeric id we store. */
function orderGid(orderId: string): string {
  return orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
}

// ---------------------------------------------------------------------------
// Resolving what to write
// ---------------------------------------------------------------------------

type SyncContext = {
  shopId: string;
  shopDomain: string;
  accessToken: string;
  orderId: string | null;
  channel: string;
  channelLabel: string;
};

/**
 * Load the response, its survey's sync options, and the channel the shopper
 * chose. The channel is resolved from the Answer row of the channel-report
 * question (the v2 model keeps the channel there, not on a column).
 */
async function loadSyncContext(shopId: string, responseId: string): Promise<{
  options: SurveySyncOptions;
  context: SyncContext;
} | null> {
  const response = await retryDb(() =>
    db.response.findFirst({
      where: { id: responseId, shopId },
      include: {
        survey: { select: { syncOptions: true, channelReportQuestionId: true } },
        answers: true,
      },
    }),
  );
  if (!response) return null;

  const options = parseSyncOptions(
    safeJson<Record<string, unknown>>(response.survey.syncOptions, {}),
  );

  let channel = "";
  let channelLabel = "";

  const reportQuestionId = response.survey.channelReportQuestionId;
  const reportAnswer = response.answers.find((a) => a.questionId === reportQuestionId);
  if (reportAnswer) {
    const optionIds = safeJson<string[]>(reportAnswer.optionIds, []);
    channel = optionIds[0] ?? "";
    if (reportAnswer.otherText) channelLabel = reportAnswer.otherText;
    if (!channelLabel && channel) {
      const option = await retryDb(() =>
        db.option.findFirst({ where: { id: channel }, select: { label: true } }),
      );
      channelLabel = option?.label ?? channel;
    }
  }

  const shopRow = await findShopById(shopId);
  if (!shopRow) return null;
  const accessToken = await getAccessToken(shopId);
  if (!accessToken) return null;

  return {
    options,
    context: {
      shopId,
      shopDomain: shopRow.shopDomain,
      accessToken,
      orderId: response.orderId,
      channel,
      channelLabel,
    },
  };
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The customer GID for an order, read from Shopify. Null when none/unreadable. */
async function fetchOrderCustomerId(ctx: SyncContext): Promise<string | null> {
  if (!ctx.orderId) return null;
  try {
    const result = await shopifyGraphql<{ order: { customer: { id: string } | null } | null }>(
      ctx.shopDomain,
      ctx.accessToken,
      ORDER_CUSTOMER,
      { id: orderGid(ctx.orderId) },
    );
    return result.data.order?.customer?.id ?? null;
  } catch (error) {
    logger.warn("sync_order_customer_failed", {
      order_id: ctx.orderId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Executing one kind
// ---------------------------------------------------------------------------

/**
 * Sanitise an order/customer tag before sending it to Shopify.
 *
 * A tag is built from the merchant's prefix plus the channel label, and the
 * channel label can be the buyer's free-text "Other" answer. A comma splits one
 * tag into several, so a shopper typing "a,b,c" would create arbitrary tags on
 * the order; control characters and length are clamped for the same reason.
 * Lower-cased and reduced to a safe character set, max 40 characters.
 */
export function sanitizeTag(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    // Drop control characters and anything that could break a tag (comma,
    // quotes, backslash). Space, letters, digits, dash, underscore, dot, colon
    // (the `prefix:channel` separator) and non-Latin letters survive.
    .replace(/[\u0000-\u001f\u007f,"'\\]/g, "")
    .replace(/[^\p{L}\p{N}\-_.: ]/gu, "")
    .trim()
    .slice(0, 40);
  return cleaned;
}

/** Hard ceiling for a Flow payload, below Shopify's 50,000-byte limit. */
export const MAX_FLOW_PAYLOAD_BYTES = 45_000;

/** Truncate a string so the JSON payload stays under `maxBytes`. */
export function truncateForPayload(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > budget) end -= 1;
  return `${value.slice(0, end)}${ellipsis}`;
}

/** Runs one PendingSync kind against Shopify. Throws so the caller can retry. */
export async function runSyncKind(
  kind: "tags" | "customer" | "metafield" | "flow",
  options: SurveySyncOptions,
  ctx: SyncContext,
  grantedScopes: string | null,
): Promise<void> {
  if (!ctx.orderId) {
    // An on-site/link answer has no order to write to. Not an error: there is
    // simply nothing to sync, so treat it as done.
    return;
  }

  if (kind === "tags") {
    if (!canSync(grantedScopes, "write_orders", ctx.shopId)) return;
    const tags = (options.orderTags ?? [])
      .map((tag) => sanitizeTag(tag.replace("{channel}", ctx.channelLabel || ctx.channel)))
      .filter((tag) => tag.length > 0);
    if (tags.length === 0) return;
    const result = await shopifyGraphql<{ tagsAdd: { userErrors: UserErrors } }>(
      ctx.shopDomain,
      ctx.accessToken,
      TAGS_ADD,
      { id: orderGid(ctx.orderId), tags },
    );
    assertNoUserErrors(result.data.tagsAdd.userErrors, "tagsAdd");
    return;
  }

  if (kind === "customer") {
    if (!canSync(grantedScopes, "write_customers", ctx.shopId)) return;
    const customerId = await fetchOrderCustomerId(ctx);
    if (!customerId) return;
    const tags = (options.customerTags ?? [])
      .map((tag) => sanitizeTag(tag.replace("{channel}", ctx.channelLabel || ctx.channel)))
      .filter((tag) => tag.length > 0);
    if (tags.length === 0) return;
    const result = await shopifyGraphql<{ tagsAdd: { userErrors: UserErrors } }>(
      ctx.shopDomain,
      ctx.accessToken,
      TAGS_ADD,
      { id: customerId, tags },
    );
    assertNoUserErrors(result.data.tagsAdd.userErrors, "tagsAdd");
    return;
  }

  if (kind === "metafield") {
    if (!canSync(grantedScopes, "write_orders", ctx.shopId)) return;
    const metafields = (options.metafields ?? []).map((m) => ({
      ownerId: orderGid(ctx.orderId!),
      namespace: m.namespace,
      key: m.key,
      // A single_line_text_field has a Shopify-imposed length cap, and the
      // channel label can be a buyer's free-text answer. Truncate rather than
      // let the write be rejected.
      value: truncateForPayload(ctx.channelLabel || ctx.channel, 500),
      type: m.type ?? "single_line_text_field",
    }));
    if (metafields.length === 0) return;
    const result = await shopifyGraphql<{ metafieldsSet: { userErrors: UserErrors } }>(
      ctx.shopDomain,
      ctx.accessToken,
      METAFIELDS_SET,
      { metafields },
    );
    assertNoUserErrors(result.data.metafieldsSet.userErrors, "metafieldsSet");
    return;
  }

  // Flow triggers are the app's own extension; no extra scope is required.
  // The payload must stay under Shopify's 50,000-byte limit or Flow rejects it
  // silently, so the free-text channel label (a possible "Other" answer) is
  // truncated to leave headroom.
  const flowPayload = {
    order_id: Number(ctx.orderId),
    Channel: ctx.channel,
    "Channel label": truncateForPayload(ctx.channelLabel, 10_000),
  };
  if (Buffer.byteLength(JSON.stringify(flowPayload), "utf8") > MAX_FLOW_PAYLOAD_BYTES) {
    throw new Error("Flow payload exceeds the size limit.");
  }
  const result = await shopifyGraphql<{ flowTriggerReceive: { userErrors: UserErrors } }>(
    ctx.shopDomain,
    ctx.accessToken,
    FLOW_TRIGGER,
    {
      handle: FLOW_TRIGGER_HANDLE,
      // Keys must match the fields declared in
      // extensions/sourcetrac-flow-trigger/shopify.extension.toml verbatim:
      // the order_reference field is `order_id`, the custom fields keep their
      // spaced keys. A mismatch makes Flow reject the payload silently.
      payload: flowPayload,
    },
  );
  assertNoUserErrors(result.data.flowTriggerReceive.userErrors, "flowTriggerReceive");
}

// ---------------------------------------------------------------------------
// Sweeping
// ---------------------------------------------------------------------------

/**
 * Process pending sync rows for one shop, due now. Each row is independent: a
 * failure bumps `attempts` and schedules the next try, a success deletes it.
 * Bounded so a request that triggers the sweep stays cheap.
 */
export async function processPendingSync(shopId: string, limit = 10): Promise<{ done: number; failed: number }> {
  const rows = await retryDb(() =>
    db.pendingSync.findMany({
      where: { shopId, attempts: { lt: MAX_SYNC_ATTEMPTS }, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
  );

  if (rows.length === 0) return { done: 0, failed: 0 };

  const shopRow = await findShopById(shopId);
  const accessToken = await getAccessToken(shopId);
  if (!shopRow || !accessToken) return { done: 0, failed: 0 };

  const session = await retryDb(() =>
    db.session.findFirst({ where: { shop: shopRow.shopDomain, isOnline: false }, select: { scope: true } }),
  );
  const grantedScopes = session?.scope ?? null;

  let done = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const loaded = await loadSyncContext(shopId, row.responseId);
      if (!loaded) {
        // The response is gone (redacted or expired). The work can never
        // succeed, so drop it rather than retrying forever.
        await retryDb(() => db.pendingSync.delete({ where: { id: row.id } }));
        continue;
      }
      await runSyncKind(row.kind, loaded.options, loaded.context, grantedScopes);
      await retryDb(() => db.pendingSync.delete({ where: { id: row.id } }));
      done += 1;
    } catch (error) {
      failed += 1;
      const attempts = row.attempts + 1;
      // Exponential backoff, capped, so a throttled store does not hammer.
      const delayMs = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
      logger.warn("sync_failed", {
        shop_id: shopId,
        response_id: row.responseId,
        kind: row.kind,
        attempts,
        error_message: error instanceof Error ? error.message : String(error),
      });
      await retryDb(() =>
        db.pendingSync.update({
          where: { id: row.id },
          data: {
            attempts,
            nextAttemptAt: new Date(Date.now() + delayMs),
            lastError: error instanceof Error ? error.message.slice(0, 500) : "unknown",
          },
        }),
      );
    }
  }

  return { done, failed };
}

/** Run the sweep at most once per process per few minutes, on a normal request. */
let lastSyncSweep: number | undefined;
const SYNC_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function maybeRunPendingSync(shopId: string): Promise<void> {
  const now = Date.now();
  if (lastSyncSweep !== undefined && now - lastSyncSweep < SYNC_SWEEP_INTERVAL_MS) return;
  lastSyncSweep = now;
  try {
    await processPendingSync(shopId);
  } catch (error) {
    lastSyncSweep = undefined;
    logger.warn("sync_sweep_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The write scopes needed to fully run a survey's sync options. */
export function requiredScopes(options: SurveySyncOptions): SyncScope[] {
  const scopes: SyncScope[] = [];
  if (options.orderTags?.length || options.metafields?.length) scopes.push("write_orders");
  if (options.customerTags?.length) scopes.push("write_customers");
  return scopes;
}

export { hasScope };
