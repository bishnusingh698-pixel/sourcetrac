import type { Prisma } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { canSync, hasScope, type SyncScope } from "~/lib/scopes.server";
import { getAccessToken, findShopById } from "~/lib/shop.server";
import { mayHaveRun, shopifyGraphql } from "~/lib/shopify-graphql.server";
import { resolveSmartActionWrites, SMART_ACTION_PRESETS, type ResolvedSmartActions } from "@shared/templates/smart-actions";
import { PLAN_SCALE, effectivePlan } from "~/lib/plans";
import { slugifyChannel } from "~/lib/settings";
import { readableChannelKey } from "~/lib/channel-key";
import { OTHER_CHANNEL_VALUE } from "@shared/survey-rules";
import {
  MAX_SYNC_TAG_LENGTH,
  MAX_SYNC_TAGS,
  normalizeTagTemplates,
  sanitizeTag,
  tagsForAnswer,
} from "@shared/sync-tags";

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
  /** Metafields to set, on the order (default) or the customer. */
  metafields?: Array<{
    namespace: string;
    key: string;
    keyTemplate?: string;
    type?: string;
    owner?: "order" | "customer";
  }>;
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

/** Shopify's metafield naming rules (namespace 3–255, key 2–64; letters, digits, `-`, `_`). */
const METAFIELD_NAMESPACE = /^[A-Za-z0-9_-]{3,255}$/;
const METAFIELD_KEY = /^[A-Za-z0-9_-]{2,64}$/;

export { MAX_SYNC_TAGS, MAX_SYNC_TAG_LENGTH, sanitizeTag };
export const MAX_SYNC_ATTEMPTS = 5;
/** Work older than this is dropped, never fired: a reinstall must not replay months-old answers. */
const MAX_SYNC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a drainer holds a row it is working on. One kind can make two
 * Shopify calls, each retried up to 4 times with a 20s timeout and backoff
 * sleeps (about 130s per call), so the lease must outlast both.
 */
const SYNC_LEASE_MS = 10 * 60 * 1000;

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

/**
 * Parse and clamp `Survey.syncOptions`. Unknown keys are ignored. Accepts the
 * stored JSON string as well as an object: the submit path passes the column
 * as read, and reading `.orderTags` off a string found nothing, so no answer
 * ever queued sync work.
 */
export function parseSyncOptions(raw: unknown): SurveySyncOptions {
  const parsed = typeof raw === "string" ? safeJson<unknown>(raw, {}) : raw;
  const source = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  // Only well-formed names and text types: the value written is always text,
  // and a malformed namespace/key or a numeric type failed every write.
  const metafields = Array.isArray(source.metafields)
    ? source.metafields
        .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
        .map((m) => ({
          namespace: String(m.namespace ?? "sourcetrac"),
          key: String(m.key ?? "channel"),
          type: m.type === "multi_line_text_field" ? "multi_line_text_field" : "single_line_text_field",
          owner: m.owner === "customer" ? ("customer" as const) : ("order" as const),
        }))
        .filter((m) => METAFIELD_NAMESPACE.test(m.namespace) && METAFIELD_KEY.test(m.key))
        .slice(0, 4)
    : undefined;

  return {
    orderTags: normalizeTagTemplates(source.orderTags),
    customerTags: normalizeTagTemplates(source.customerTags),
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
      // Only presets we recognise produce work; an unknown id (a survey saved
      // by a newer build, then rolled back) would otherwise enqueue a row that
      // writes nothing.
      (options.presets && options.presets.some((id) => SMART_ACTION_PRESETS[id])) ||
      options.flowTrigger,
  );
}

/** Which PendingSync kinds `syncOptions` requires, in a stable order. */
function requiredKinds(options: SurveySyncOptions): Array<"tags" | "customer" | "metafield" | "flow"> {
  const kinds: Array<"tags" | "customer" | "metafield" | "flow"> = [];
  const presets = (options.presets ?? []).map((id) => SMART_ACTION_PRESETS[id]).filter(Boolean);
  const wantsOrderTag = (options.orderTags?.length ?? 0) > 0 || presets.some((p) => p!.kind === "order_tag");
  const wantsCustomerTag = (options.customerTags?.length ?? 0) > 0 || presets.some((p) => p!.kind === "customer_tag");
  const wantsMetafield = (options.metafields?.length ?? 0) > 0 || presets.some((p) => p!.kind === "customer_metafield");
  if (wantsOrderTag) kinds.push("tags");
  if (wantsCustomerTag) kinds.push("customer");
  if (wantsMetafield) kinds.push("metafield");
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

  // Check and insert under a per-response lock: two submits (or a submit and a
  // retry) used to both see "nothing pending" and both insert, which fired the
  // merchant's Flow twice.
  const toCreate = await retryDb(() =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sync:${responseId}`}))`;
      const existing = await tx.pendingSync.findMany({ where: { shopId, responseId }, select: { kind: true } });
      const have = new Set(existing.map((row) => row.kind));
      const missing = kinds.filter((kind) => !have.has(kind));
      if (missing.length > 0) {
        await tx.pendingSync.createMany({ data: missing.map((kind) => ({ shopId, responseId, kind })) });
      }
      return missing;
    }),
  );
  if (toCreate.length === 0) return;
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
  /** Template provenance, for T13 preset resolution. Null for from-scratch surveys. */
  templateId: string | null;
  /** The preset ids the merchant turned on, resolved into tags per answer. */
  presetIds: string[];
  /** The stored answers, for preset resolution. */
  answers: Array<{ questionId: string; optionIds: string[]; numberValue: number | null }>;
  /** The buyer's free-text "Other" answer, if any. Never put into a tag. */
  otherText: string | null;
  /** From the Thank-you page; null when unknown. Gates first-order presets. */
  isFirstOrder: boolean | null;
};

/**
 * Load the response, its survey's sync options, and the channel the shopper
 * chose. The channel is resolved from the Answer row of the channel-report
 * question (the v2 model keeps the channel there, not on a column).
 */
type LoadedSync =
  | { status: "ready"; options: SurveySyncOptions; context: SyncContext }
  /** The response or shop is gone (redacted, expired): the work can never run. */
  | { status: "gone" }
  /** The shop is on a plan without Shopify actions: settled, nothing to write. */
  | { status: "not_on_plan" };

async function loadSyncContext(shopId: string, responseId: string, accessToken: string): Promise<LoadedSync> {
  const response = await retryDb(() =>
    db.response.findFirst({
      where: { id: responseId, shopId },
      include: {
        survey: { select: { syncOptions: true, channelReportQuestionId: true, templateId: true } },
        answers: {
          include: {
            question: {
              select: {
                templateKey: true,
                type: true,
                position: true,
                options: { select: { id: true, templateKey: true, label: true } },
              },
            },
          },
        },
      },
    }),
  );
  if (!response) return { status: "gone" };

  const options = parseSyncOptions(response.survey.syncOptions);
  // The channel as a merchant can match on it: a readable key (the legacy
  // value, the template's option key, or a slug of the label) and the option's
  // own label. Never the internal row id, and never the buyer's free text: an
  // "Other" answer is the channel `other`, its text is kept separately.
  let channel = "";
  let channelLabel = "";
  let otherText: string | null = null;

  // The channel question when the survey has one; otherwise the first choice
  // question, which is what the editor tells the merchant tags will use.
  const reportQuestionId = response.survey.channelReportQuestionId;
  const reportAnswer =
    response.answers.find((a) => a.questionId === reportQuestionId) ??
    [...response.answers]
      .filter((a) => a.question.type === "single_choice" || a.question.type === "dropdown")
      .sort((a, b) => a.question.position - b.question.position)[0];
  if (reportAnswer) {
    const optionId = safeJson<string[]>(reportAnswer.optionIds, [])[0] ?? "";
    otherText = reportAnswer.otherText?.trim() || null;
    const option = optionId
      ? await retryDb(() =>
          db.option.findFirst({
            where: { id: optionId, questionId: reportAnswer.questionId },
            select: { label: true, isOther: true, templateKey: true },
          }),
        )
      : null;
    if (optionId === OTHER_CHANNEL_VALUE || option?.isOther) {
      channel = OTHER_CHANNEL_VALUE;
      channelLabel = option?.label ?? "Other";
    } else if (option) {
      channel = readableChannelKey({
        shopId,
        optionId,
        optionTemplateKey: option.templateKey,
        questionTemplateKey: reportAnswer.question.templateKey,
        label: option.label,
      });
      channelLabel = option.label;
    }
  }

  const shopRow = await findShopById(shopId);
  if (!shopRow) return { status: "gone" };

  // T13 is Pro-only. Gate on the *current* plan here, not only at enqueue time:
  // the lazy sweep re-reads `syncOptions` from the database, so a shop that
  // downgraded after enqueue would otherwise still write presets. Dropping them
  // from the loaded options keeps the scope/plan gates in one place. Uses the
  // same `effectivePlan` rule as submit, so a cancelled Scale plan agrees on
  // both sides.
  if (effectivePlan(shopRow) !== PLAN_SCALE) delete options.presets;
  // Every other Shopify write (order and customer tags, metafields, Flow) is a
  // Scale feature too. Same reasoning: a shop that downgraded keeps its stored
  // settings, so an upgrade restores them, but nothing more is written.
  // A frozen paid plan (an unpaid bill) is not a downgrade:
  // defer (the caller throws, so the row backs off) rather than settle it.
  if (effectivePlan(shopRow) !== PLAN_SCALE) {
    if (shopRow.plan === PLAN_SCALE && shopRow.planStatus === "frozen") {
      throw new Error("Scale plan is frozen; waiting for it to be active again.");
    }
    return { status: "not_on_plan" };
  }

  return {
    status: "ready",
    options,
    context: {
      shopId,
      shopDomain: shopRow.shopDomain,
      accessToken,
      orderId: response.orderId,
      channel,
      channelLabel,
      templateId: response.survey.templateId,
      presetIds: options.presets ?? [],
      otherText,
      isFirstOrder: response.isFirstOrder,
      // Smart-action presets name the template's stable ids. Rows have their
      // own unique ids and remember the stable one as `templateKey`.
      answers: response.answers.map((a) => {
        // An option the merchant added to a template survey has no template
        // key; give it a readable one from its label, never the row id.
        const prefix = a.question.templateKey ? `${a.question.templateKey}_` : "";
        const optionKeys = new Map(
          a.question.options.map((o) => [o.id, o.templateKey ?? `${prefix}${slugifyChannel(o.label, new Set())}`]),
        );
        return {
          questionId: a.question.templateKey ?? a.questionId,
          optionIds: safeJson<string[]>(a.optionIds, []).map((id) => optionKeys.get(id) ?? id),
          numberValue: a.numberValue,
        };
      }),
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

/**
 * The customer GID for an order, read from Shopify. Null only when the order
 * genuinely has no customer. A lookup failure, or an order Shopify has not
 * created yet (the inline Thank-you sync), throws so the work is retried later
 * instead of being recorded as done with nothing written.
 */
async function fetchOrderCustomerId(ctx: SyncContext): Promise<string | null> {
  if (!ctx.orderId) return null;
  const result = await shopifyGraphql<{ order: { customer: { id: string } | null } | null }>(
    ctx.shopDomain,
    ctx.accessToken,
    ORDER_CUSTOMER,
    { id: orderGid(ctx.orderId) },
  );
  if (!result.data.order) throw new Error("Order not available yet.");
  return result.data.order.customer?.id ?? null;
}

/** A metafield value within Shopify's limits for its text type. */
function metafieldValue(value: string, type: string | undefined): string {
  return truncateForPayload(type === "multi_line_text_field" ? value : singleLine(value), 500);
}

/** Single-line metafields refuse line breaks; a buyer's text can contain them. */
function singleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Executing one kind
// ---------------------------------------------------------------------------

/** Hard ceiling for a Flow payload, below Shopify's 50,000-byte limit. */
export const MAX_FLOW_PAYLOAD_BYTES = 45_000;

/**
 * The tags/metafields the survey's enabled T13 presets produce for this answer.
 * Empty when the survey was not created from a template or has no presets, so
 * the plain `orderTags`/`customerTags`/`metafields` path is unaffected.
 */
function presetWrites(ctx: SyncContext): ResolvedSmartActions {
  if (!ctx.templateId || ctx.presetIds.length === 0) {
    return { orderTags: [], customerTags: [], customerMetafields: [] };
  }
  return resolveSmartActionWrites({
    templateId: ctx.templateId,
    presetIds: ctx.presetIds,
    answers: ctx.answers,
    isFirstOrder: ctx.isFirstOrder,
  });
}

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
    const tags = [
      ...tagsForAnswer(options.orderTags ?? [], ctx.channelLabel || ctx.channel),
      ...presetWrites(ctx).orderTags.map(sanitizeTag),
    ].filter((tag) => tag.length > 0);
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
    const tags = [
      ...tagsForAnswer(options.customerTags ?? [], ctx.channelLabel || ctx.channel),
      ...presetWrites(ctx).customerTags.map(sanitizeTag),
    ].filter((tag) => tag.length > 0);
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
    const presetMetafields = presetWrites(ctx).customerMetafields;
    const orderMetafields = (options.metafields ?? [])
      .filter((m) => m.owner !== "customer")
      .map((m) => ({
        ownerId: orderGid(ctx.orderId!),
        namespace: m.namespace,
        key: m.key,
        // A single_line_text_field has a Shopify-imposed length cap, and the
        // channel label can be a buyer's free-text answer. Truncate rather than
        // let the write be rejected.
        value: metafieldValue(ctx.channelLabel || ctx.channel, m.type),
        type: m.type ?? "single_line_text_field",
      }));

    // Customer-owned metafields (an explicit customer metafield, or a T13
    // preset like the profile/reorder value) need the customer scope and the
    // order's customer. Order metafields only need the order scope.
    const wantsCustomerMetafield =
      presetMetafields.length > 0 || (options.metafields ?? []).some((m) => m.owner === "customer");
    const customerMetafields = (options.metafields ?? []).filter((m) => m.owner === "customer");

    const writes: Array<{
      ownerId: string;
      namespace: string;
      key: string;
      value: string;
      type: string;
    }> = [];
    if (orderMetafields.length > 0 && canSync(grantedScopes, "write_orders", ctx.shopId)) {
      writes.push(...orderMetafields);
    }
    if (wantsCustomerMetafield && canSync(grantedScopes, "write_customers", ctx.shopId)) {
      const customerId = await fetchOrderCustomerId(ctx);
      if (customerId) {
        for (const m of customerMetafields) {
          writes.push({
            ownerId: customerId,
            namespace: m.namespace,
            key: m.key,
            value: metafieldValue(ctx.channelLabel || ctx.channel, m.type),
            type: m.type ?? "single_line_text_field",
          });
        }
        // Preset metafields carry the answer itself, not the channel.
        for (const m of presetMetafields) {
          writes.push({
            ownerId: customerId,
            namespace: m.namespace,
            key: m.key,
            value: m.type === "number_integer" ? m.value : metafieldValue(m.value, "single_line_text_field"),
            type: m.type,
          });
        }
      }
    }
    // An empty value is refused by Shopify, and two writes to one field in the
    // same call fail the whole atomic call: keep the first (the merchant's own
    // setting comes before a preset).
    const seen = new Set<string>();
    const unique = writes.filter((write) => {
      const field = `${write.ownerId}|${write.namespace}|${write.key}`;
      if (write.value.length === 0 || seen.has(field)) return false;
      seen.add(field);
      return true;
    });
    // One call per owner, so a conflict on a customer field (a merchant
    // definition of another type) cannot also block the order's fields. Both
    // writes are idempotent, so a retry after one succeeded is harmless.
    const failures: string[] = [];
    for (const ownerId of [...new Set(unique.map((write) => write.ownerId))]) {
      const result = await shopifyGraphql<{ metafieldsSet: { userErrors: UserErrors } }>(
        ctx.shopDomain,
        ctx.accessToken,
        METAFIELDS_SET,
        { metafields: unique.filter((write) => write.ownerId === ownerId) },
      );
      try {
        assertNoUserErrors(result.data.metafieldsSet.userErrors, "metafieldsSet");
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    return;
  }

  // Flow triggers are the app's own extension; no extra scope is required.
  // The payload must stay under Shopify's 50,000-byte limit or Flow rejects it
  // silently, so the free-text channel label (a possible "Other" answer) is
  // truncated to leave headroom.
  // Flow resolves `order_id` to the order: fire only once Shopify has told us
  // about it, or the order reference cannot resolve. Retried with backoff.
  const flowOrderId = ctx.orderId;
  const known = await retryDb(() =>
    db.orderCache.findUnique({
      where: { shopId_orderId: { shopId: ctx.shopId, orderId: flowOrderId } },
      select: { id: true },
    }),
  );
  if (!known) throw new Error("Order not received yet; Flow will fire once it arrives.");

  const flowPayload = {
    order_id: Number(ctx.orderId),
    // A readable key a merchant can write a condition on (`instagram`, `other`),
    // never an internal row id.
    Channel: ctx.channel,
    // A single-line field: a buyer's "Other" text can carry line breaks.
    "Channel label": truncateForPayload(
      singleLine(ctx.channel === OTHER_CHANNEL_VALUE && ctx.otherText ? ctx.otherText : ctx.channelLabel),
      10_000,
    ),
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
    // Not idempotent: a 5xx after Shopify accepted the trigger must not run
    // the merchant's workflow again. A failed attempt is retried by the sweep.
    { idempotent: false },
  );
  assertNoUserErrors(result.data.flowTriggerReceive.userErrors, "flowTriggerReceive");
}

// ---------------------------------------------------------------------------
// Sweeping
// ---------------------------------------------------------------------------

/**
 * Process pending sync rows for one shop, due now. Each row is independent: a
 * failure bumps `attempts` and schedules the next try, a success marks it
 * completed (kept, so a repeated submit never queues the same work again).
 * Bounded so a request that triggers the sweep stays cheap.
 */
export async function processPendingSync(
  shopId: string,
  limit = 10,
  filter: { responseId?: string } = {},
): Promise<{ done: number; failed: number }> {
  const now = new Date();
  const rows = await retryDb(() =>
    db.pendingSync.findMany({
      where: {
        shopId,
        ...(filter.responseId ? { responseId: filter.responseId } : {}),
        completedAt: null,
        attempts: { lt: MAX_SYNC_ATTEMPTS },
        nextAttemptAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
  );

  if (rows.length === 0) return { done: 0, failed: 0 };

  const shopRow = await findShopById(shopId);
  const accessToken = await getAccessToken(shopId);
  if (!shopRow || !accessToken) {
    logger.warn("sync_skipped_no_credentials", { shop_id: shopId, pending: rows.length, has_shop: Boolean(shopRow) });
    return { done: 0, failed: 0 };
  }

  const session = await retryDb(() =>
    db.session.findFirst({ where: { shop: shopRow.shopDomain, isOnline: false }, select: { scope: true } }),
  );
  const grantedScopes = session?.scope ?? null;

  let done = 0;
  let failed = 0;

  for (const row of rows) {
    // Claim the row with a lease: only the drainer whose conditional update
    // matches works on it. The lease is its own column, so the backoff reset
    // when an order arrives (`startSyncForOrder`) can never hand a row that is
    // being worked on to a second drainer and run the merchant's Flow twice.
    const lease = new Date(Date.now() + SYNC_LEASE_MS);
    const claimed = await retryDb(() =>
      db.pendingSync.updateMany({
        where: {
          id: row.id,
          completedAt: null,
          attempts: row.attempts,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        data: { leaseUntil: lease },
      }),
    );
    if (claimed.count === 0) continue;
    // Every later write is conditional on still holding this lease, so a
    // drainer whose lease ran out cannot overwrite the new owner's outcome.
    const settle = (data: Prisma.PendingSyncUpdateManyMutationInput) =>
      retryDb(() => db.pendingSync.updateMany({ where: { id: row.id, leaseUntil: lease }, data: { ...data, leaseUntil: null } }));

    if (now.getTime() - row.createdAt.getTime() > MAX_SYNC_AGE_MS) {
      // Too old to write now (for example, queued before an uninstall). Kept
      // as failed, so the Settings page counts it rather than it vanishing.
      logger.warn("sync_dropped_stale", { shop_id: shopId, response_id: row.responseId, kind: row.kind });
      await settle({ attempts: MAX_SYNC_ATTEMPTS, lastError: "Not written: still pending after 7 days." });
      continue;
    }

    try {
      const loaded = await loadSyncContext(shopId, row.responseId, accessToken);
      if (loaded.status === "gone") {
        // The response is gone (redacted or expired). The work can never
        // succeed, so drop it rather than retrying forever.
        await retryDb(() => db.pendingSync.deleteMany({ where: { id: row.id, leaseUntil: lease } }));
        continue;
      }
      if (loaded.status === "ready") {
        await runSyncKind(row.kind, loaded.options, loaded.context, grantedScopes);
      }
      await settle({ completedAt: new Date(), lastError: null });
      done += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (row.kind === "flow" && mayHaveRun(error)) {
        // Shopify may already have run the merchant's workflow (a 5xx or a
        // timeout after the trigger was sent). Flow has no idempotency key, so
        // sending it again could run the workflow twice: settle it instead.
        logger.error("sync_flow_outcome_unknown", {
          shop_id: shopId,
          response_id: row.responseId,
          error_message: message,
        });
        await settle({ completedAt: new Date(), lastError: `Outcome unknown, not resent: ${message}`.slice(0, 500) });
        continue;
      }
      failed += 1;
      const attempts = row.attempts + 1;
      // Exponential backoff from a minute up to six hours, so a throttled store
      // is not hammered and a slow order has time to arrive.
      const delayMs = Math.min(4 ** attempts * 15_000, 6 * 60 * 60 * 1000);
      const gaveUp = attempts >= MAX_SYNC_ATTEMPTS;
      (gaveUp ? logger.error : logger.warn)(gaveUp ? "sync_gave_up" : "sync_failed", {
        shop_id: shopId,
        response_id: row.responseId,
        kind: row.kind,
        attempts,
        error_message: message,
      });
      await settle({ attempts, nextAttemptAt: new Date(Date.now() + delayMs), lastError: message.slice(0, 500) });
      if (!gaveUp) scheduleRetry(shopId, delayMs);
    }
  }

  return { done, failed };
}

/**
 * Wake this shop's sweep when a backed-off row is due, so queued work does not
 * wait for an admin visit or an order webhook. In-process and best-effort: a
 * restart loses the timer, and the admin and webhook sweeps still cover it.
 * Only armed after a failure, so an idle app never touches the database.
 */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRetry(shopId: string, delayMs: number): void {
  if (retryTimers.has(shopId) || retryTimers.size > 1_000) return;
  const timer = setTimeout(() => {
    retryTimers.delete(shopId);
    void processPendingSync(shopId).catch((error: unknown) => {
      logger.warn("sync_retry_failed", {
        shop_id: shopId,
        error_message: error instanceof Error ? error.message : String(error),
      });
    });
  }, delayMs + 1_000);
  timer.unref?.();
  retryTimers.set(shopId, timer);
}

/**
 * Run a shop's sweep at most once per few minutes, on a normal request. The
 * throttle is per shop: one process-wide timestamp let one shop's visit skip
 * every other shop's sweep.
 */
const lastSyncSweep = new Map<string, number>();
const SYNC_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function maybeRunPendingSync(shopId: string): Promise<void> {
  const now = Date.now();
  const last = lastSyncSweep.get(shopId);
  if (last !== undefined && now - last < SYNC_SWEEP_INTERVAL_MS) return;
  if (lastSyncSweep.size > 10_000) lastSyncSweep.clear();
  lastSyncSweep.set(shopId, now);
  try {
    await processPendingSync(shopId);
  } catch (error) {
    lastSyncSweep.delete(shopId);
    logger.warn("sync_sweep_failed", {
      shop_id: shopId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The write scopes needed to fully run a survey's sync options. */
export function requiredScopes(options: SurveySyncOptions): SyncScope[] {
  const scopes: SyncScope[] = [];
  const presets = (options.presets ?? []).map((id) => SMART_ACTION_PRESETS[id]).filter(Boolean);
  const wantsOrders =
    (options.orderTags?.length ?? 0) > 0 ||
    (options.metafields?.some((m) => m.owner !== "customer") ?? false) ||
    presets.some((p) => p!.kind === "order_tag");
  const wantsCustomers =
    (options.customerTags?.length ?? 0) > 0 ||
    (options.metafields?.some((m) => m.owner === "customer") ?? false) ||
    presets.some((p) => p!.kind === "customer_tag" || p!.kind === "customer_metafield");
  if (wantsOrders) scopes.push("write_orders");
  if (wantsCustomers) scopes.push("write_customers");
  return scopes;
}

/**
 * Run the sync work waiting on one order, in the background, as soon as the
 * order arrives. Flow and the customer lookup need the order to exist, and the
 * Thank-you answer usually comes first; without this the work waited for its
 * backoff and a merchant's admin visit (and was dropped after a week).
 */
export function startSyncForOrder(shopId: string, orderId: string): void {
  void (async () => {
    const responses = await retryDb(() =>
      db.response.findMany({ where: { shopId, orderId }, select: { id: true } }),
    );
    for (const { id } of responses) {
      const now = new Date();
      // Only rows waiting out their backoff; a row a drainer holds keeps its lease.
      const due = await retryDb(() =>
        db.pendingSync.updateMany({
          where: {
            shopId,
            responseId: id,
            completedAt: null,
            attempts: { lt: MAX_SYNC_ATTEMPTS },
            nextAttemptAt: { gt: now },
            OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
          },
          data: { nextAttemptAt: now },
        }),
      );
      const pending =
        due.count > 0 ||
        (await retryDb(() => db.pendingSync.count({ where: { shopId, responseId: id, completedAt: null } }))) > 0;
      if (pending) await processPendingSync(shopId, 10, { responseId: id });
    }
  })().catch((error: unknown) => {
    logger.warn("sync_for_order_failed", {
      shop_id: shopId,
      order_id: orderId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Sync work that gave up after every retry, for the Settings page. */
export async function countFailedSync(shopId: string): Promise<{ count: number; lastError: string | null }> {
  const [count, latest] = await Promise.all([
    retryDb(() => db.pendingSync.count({ where: { shopId, completedAt: null, attempts: { gte: MAX_SYNC_ATTEMPTS } } })),
    retryDb(() =>
      db.pendingSync.findFirst({
        where: { shopId, completedAt: null, attempts: { gte: MAX_SYNC_ATTEMPTS } },
        orderBy: { createdAt: "desc" },
        select: { lastError: true },
      }),
    ),
  ]);
  return { count, lastError: latest?.lastError ?? null };
}

export { hasScope };
