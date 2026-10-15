/**
 * Multi-question answer ingestion (the new /api/survey-responses path).
 *
 * Mirrors `responses.server.ts` for the OLD single-question model: same
 * duplicate-as-success rule, same free-cap policy, same never-lose-a-buyer's-
 * answer guarantee, same reconciliation. The difference is that an answer is a
 * set of per-question rows rather than one channel string, and that a survey can
 * appear on more than one surface.
 *
 * This is the only place that writes `Response` / `Answer`.
 */

import { Prisma } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { minorToDecimalString, parseMoneyToMinor } from "~/lib/money";
import { currentUtcPeriod, evaluateCap, planFor, type PlanKey } from "~/lib/plans";
import { withRetry } from "~/lib/retry.server";
import { invalidateConfig } from "~/lib/surveys.server";
import { isRedactedOrder } from "~/lib/compliance.server";
import { enqueueSync, hasSyncWork, parseSyncOptions, processPendingSync } from "~/lib/sync.server";
import { shouldLearnAndStop } from "@shared/templates/confidence";
import {
  normalizeResponseAnswers,
  OTHER_CHANNEL_VALUE,
  validateResponse,
  type AnswerInput,
  type SurveyDefinition,
} from "@shared/survey-rules";
import type { Placement } from "@shared/survey-config";

export type AnswerSubmitInput = {
  shopId: string;
  surveyId: string;
  /** The published version the buyer answered. */
  surveyVersion: number;
  /** The survey's current published version; a lower `surveyVersion` is stale. */
  currentVersion?: number;
  orderId: string | null;
  placement: Placement;
  locale: string | null;
  answers: AnswerInput[];
  /** T8: product ids on the order's lines, for results by product. */
  productIds?: string[];
  /** From the Thank-you page; null when unknown. */
  isFirstOrder?: boolean | null;
  country?: string | null;
  plan: PlanKey;
  definition: SurveyDefinition;
  /** The survey's raw `syncOptions` JSON string, for the optional Phase 7 sync. */
  syncOptions?: string | null;
  /** T10: pause once results are reliable. */
  learnAndStop?: boolean;
  /** T10: the main (first choice/score) question to measure, or null. */
  mainQuestionId?: string | null;
};

export type AnswerSubmitResult =
  | { outcome: "created"; id: string; isLocked: boolean; counted: boolean }
  | { outcome: "duplicate"; id: string; isLocked: boolean; counted: boolean }
  | { outcome: "invalid"; issues: string[] };

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** The plan's monthly cap, or null when unlimited. */
export function capOf(plan: PlanKey): number | null {
  return planFor(plan).responseCap;
}

/**
 * Whether this order is known and countable, used to snapshot `Response.verified`.
 * A known order with a parseable total is verified; an order that has not landed
 * (or whose total is unreadable) is not, and its revenue is excluded until it is.
 */
async function isCountableOrder(shopId: string, orderId: string | null): Promise<boolean> {
  if (!orderId) return false;
  const order = await retryDb(() =>
    db.orderCache.findUnique({
      where: { shopId_orderId: { shopId, orderId } },
      select: { totalPrice: true, isTest: true, isCancelled: true },
    }),
  );
  if (!order || order.totalPrice === null) return false;
  // A test or cancelled order is a real order but never verified revenue, so it
  // reads as unverified here; the read-time decision agrees.
  return !order.isTest && !order.isCancelled;
}

/**
 * Atomically claim one slot against the plan's monthly cap.
 *
 * The cap must be enforced on the server, not only by the pre-insert read: two
 * answers arriving together at cap-1 both pass an unlocked read and both write.
 * The increment is a single upsert, so Postgres serialises it and exactly one
 * request can take the last slot. Returns `{ count, withinCap }` where `count`
 * is this answer's true position and `withinCap` is false when it landed past
 * the cap (the answer is still stored, just flagged).
 */
export async function claimUsageSlot(shopId: string, cap: number | null): Promise<{ count: number; withinCap: boolean }> {
  return retryDb(() => claimUsageSlotWith(db, shopId, cap));
}

/** `claimUsageSlot` on a given client, so the submit transaction can include it. */
async function claimUsageSlotWith(
  client: Prisma.TransactionClient | typeof db,
  shopId: string,
  cap: number | null,
): Promise<{ count: number; withinCap: boolean }> {
  const { periodStart, periodEnd } = currentUtcPeriod();
  {
    // One statement: insert the period's row or count one more on it. Every
    // answer is counted (the legacy single-question path does the same on the
    // same row), so the displayed usage is the true volume, never frozen at
    // the cap. Postgres serialises the row update, so each concurrent answer
    // gets a distinct position and exactly the ones past the cap are flagged.
    const id = `usage_${randomId()}`;
    const rows = await client.$queryRaw<Array<{ responsesCount: number }>>`
      INSERT INTO "BillingUsage" ("id", "shopId", "periodStart", "periodEnd", "responsesCount", "cap", "updatedAt")
      VALUES (${id}, ${shopId}, ${periodStart}, ${periodEnd}, 1, ${cap}, now())
      ON CONFLICT ("shopId", "periodStart") DO UPDATE
        SET "responsesCount" = "BillingUsage"."responsesCount" + 1,
            "cap" = ${cap},
            "updatedAt" = now()
      RETURNING "responsesCount"
    `;
    const count = rows[0]?.responsesCount ?? 1;
    return { count, withinCap: cap === null || count <= cap };
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function getUsageCount(shopId: string): Promise<number> {
  const { periodStart } = currentUtcPeriod();
  const row = await retryDb(() =>
    db.billingUsage.findUnique({
      where: { shopId_periodStart: { shopId, periodStart } },
      select: { responsesCount: true },
    }),
  );
  return row?.responsesCount ?? 0;
}

/** The channel that feeds the merchant's "how did you hear" report. */
function channelAnswer(
  definition: SurveyDefinition,
  answers: AnswerInput[],
): { channel: string; otherText: string | null } {
  for (const answer of answers) {
    const question = definition.questions.find((q) => q.id === answer.questionId);
    if (!question) continue;
    if (question.type !== "single_choice" && question.type !== "dropdown") continue;
    const id = (answer.optionIds ?? [])[0];
    if (!id) continue;
    if (id === OTHER_CHANNEL_VALUE) {
      return { channel: OTHER_CHANNEL_VALUE, otherText: answer.otherText?.trim() || null };
    }
    return { channel: id, otherText: null };
  }
  return { channel: "", otherText: null };
}

/**
 * Record a full set of answers.
 *
 * The answers are first normalised against the published definition
 * (`normalizeResponseAnswers`): archived questions and answers to hidden
 * questions are dropped, each answer keeps only its type's fields, and a buyer
 * who answered an older published version is not refused for a question added
 * since. Then the same rules as the editor validate it. An invalid submission is
 * refused; it is never partially written.
 *
 * The write is one transaction: a per-order advisory lock, the "already answered
 * on any survey" check, the usage claim, the insert and the survey's response
 * count. Either all of it lands or none of it does, so a retry after a dropped
 * commit finds the row and reports a duplicate instead of counting twice, and a
 * failed usage claim fails the request (the extension retries) instead of
 * storing an answer that was neither counted nor flagged.
 */
export async function submitAnswers(input: AnswerSubmitInput): Promise<AnswerSubmitResult> {
  const stale = input.currentVersion != null && input.surveyVersion < input.currentVersion;
  const normalized = normalizeResponseAnswers(input.definition, input.answers, { stale });
  let issues = [...normalized.issues, ...validateResponse(normalized.definition, normalized.answers)];
  // A question added (or made required) after the buyer loaded the survey could
  // not have been answered; everything else is still enforced.
  if (stale) issues = issues.filter((i) => i.code !== "required");
  if (issues.length > 0) {
    return { outcome: "invalid", issues: issues.map((i) => `${i.path}: ${i.code}`) };
  }
  const answers = normalized.answers;

  // The buyer of an order that was redacted asked for its data to be erased;
  // nothing about that order is stored again. The buyer still sees thanks.
  if (input.orderId && (await isRedactedOrder(input.shopId, input.orderId))) {
    logger.info("answer_redacted_order_ignored", { shop_id: input.shopId, survey_id: input.surveyId });
    return { outcome: "duplicate", id: "", isLocked: false, counted: true };
  }

  const usedBefore = await getUsageCount(input.shopId);
  const capStatus = evaluateCap(input.plan, usedBefore);
  const shouldLock = capStatus.shouldFlag;

  const { channel } = channelAnswer(normalized.definition, answers);
  const orderTotal = await orderTotalFor(input.shopId, input.orderId);

  // Order verification: a known, countable order is "verified"; anything else is
  // unverified and its revenue only counts once the order webhook (or the
  // backfill) lands and stores the real total. `verified` is a snapshot; the
  // authoritative revenue decision is still `decideSurveyRevenue` at read time.
  const verified = await isCountableOrder(input.shopId, input.orderId);

  let written: { kind: "created" | "duplicate"; id: string; flagged: boolean; surveyId: string };
  try {
    written = await retryDb(() =>
      db.$transaction(async (tx) => {
        if (input.orderId) {
          // One order, one answer set, across every survey and surface. The lock
          // serialises the Thank-you and Order-status pages submitting together,
          // which a plain read-then-insert could not.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`answer:${input.shopId}:${input.orderId}`}))`;
          const existing = await tx.response.findFirst({
            where: { shopId: input.shopId, orderId: input.orderId },
            select: { id: true, flagged: true, surveyId: true },
          });
          if (existing) return { kind: "duplicate" as const, ...existing };
          // An answer from the single-question path counts too (I17).
          const legacy = await tx.surveyResponse.findFirst({
            where: { shopId: input.shopId, orderId: input.orderId },
            select: { id: true, isLocked: true },
          });
          if (legacy) return { kind: "duplicate" as const, id: legacy.id, flagged: legacy.isLocked, surveyId: "" };
        }

        // Atomic claim so 20 simultaneous submissions cannot exceed the cap: the
        // conditional UPDATE lets exactly one take the last slot.
        const claimed = await claimUsageSlotWith(tx, input.shopId, capOf(input.plan));

        const created = await tx.response.create({
          data: {
            shopId: input.shopId,
            surveyId: input.surveyId,
            surveyVersion: input.surveyVersion,
            orderId: input.orderId,
            orderTotal: orderTotal?.decimal ?? null,
            currency: orderTotal?.currency ?? null,
            placement: input.placement,
            locale: input.locale,
            productIds: JSON.stringify((input.productIds ?? []).slice(0, 10)),
            isFirstOrder: input.isFirstOrder ?? null,
            country: input.country ?? null,
            flagged: shouldLock || !claimed.withinCap,
            verified,
            answers: {
              create: answers.map((answer) => ({
                shopId: input.shopId,
                questionId: answer.questionId,
                optionIds: JSON.stringify(answer.optionIds ?? []),
                numberValue: answer.numberValue ?? null,
                textValue: answer.textValue?.slice(0, 500) ?? null,
                otherText: answer.otherText?.slice(0, 500) ?? null,
              })),
            },
          },
          select: { id: true, flagged: true, surveyId: true },
        });

        // Keep the denormalised per-survey count in step with the response rows.
        await tx.survey.update({ where: { id: input.surveyId }, data: { responseCount: { increment: 1 } } });

        return { kind: "created" as const, ...created };
      }),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Only reachable when another writer bypassed the lock (the legacy path).
    const existing = input.orderId
      ? await retryDb(() =>
          db.response.findFirst({
            where: { shopId: input.shopId, orderId: input.orderId },
            select: { id: true, flagged: true, surveyId: true },
          }),
        )
      : null;
    if (!existing) throw error;
    written = { kind: "duplicate", ...existing };
  }

  if (written.kind === "duplicate") {
    logger.info("answer_duplicate_ignored", {
      shop_id: input.shopId,
      survey_id: input.surveyId,
      response_id: written.id,
    });
  }

  // A duplicate of this same survey is a retry of a write whose response never
  // reached the buyer: finish the follow-up work it may have missed. Every step
  // below is idempotent. A duplicate from another survey (the other surface
  // answered first) has its own follow-ups.
  if (written.kind === "created" || written.surveyId === input.surveyId) {
    await afterAnswerStored(input, written.id, orderTotal === null);
  }

  if (written.kind === "created") {
    logger.info("answer_created", {
      shop_id: input.shopId,
      survey_id: input.surveyId,
      response_id: written.id,
      channel,
      is_locked: written.flagged,
      answer_count: answers.length,
    });
  }

  return { outcome: written.kind, id: written.id, isLocked: written.flagged, counted: !written.flagged };
}

/** Best-effort follow-ups after an answer is stored. None of them fails the buyer. */
async function afterAnswerStored(input: AnswerSubmitInput, responseId: string, totalMissing: boolean): Promise<void> {
  // The order webhook can land between our OrderCache read and the insert; its
  // reconcile then found no Response to fill. Re-run it now that the row exists.
  if (totalMissing && input.orderId) {
    try {
      await reconcileFromCachedOrder(input.shopId, input.orderId);
    } catch (reconcileError) {
      logger.warn("answer_post_insert_reconcile_failed", {
        shop_id: input.shopId,
        response_id: responseId,
        error_message: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      });
    }
  }

  // T10: Learn & stop. Once this response makes the main question reliable,
  // pause the survey. The pause lives in the same path as a manual pause, and
  // recompiling the config is what makes shoppers stop seeing it.
  if (input.learnAndStop && input.mainQuestionId) {
    try {
      await maybeLearnAndStop(input.shopId, input.surveyId, input.mainQuestionId);
    } catch (learnError) {
      logger.warn("answer_learn_stop_failed", {
        shop_id: input.shopId,
        survey_id: input.surveyId,
        error_message: learnError instanceof Error ? learnError.message : String(learnError),
      });
    }
  }

  // Optional Shopify write-back (Phase 7). Off unless the survey configured it.
  // Recorded here; the Shopify calls run in the background so the buyer's
  // request never waits on Shopify (a throttled shop could otherwise hold it
  // past the extension's 60s budget and trigger retries). Anything that cannot
  // run yet stays pending for the lazy sweep.
  try {
    const options = parseSyncOptions(input.syncOptions);
    // T13 smart actions are Pro-only. A downgraded shop may still carry the
    // presets in its stored config, so drop them unless the plan grants them.
    if (input.plan !== "scale" && options.presets) {
      delete options.presets;
    }
    // Every Shopify write is a Scale feature, so nothing is queued below it.
    if (input.plan === "scale" && hasSyncWork(options)) {
      await enqueueSync(input.shopId, responseId, options);
      void processPendingSync(input.shopId, 5, { responseId }).catch((syncError: unknown) => {
        logger.warn("answer_sync_failed", {
          shop_id: input.shopId,
          response_id: responseId,
          error_message: syncError instanceof Error ? syncError.message : String(syncError),
        });
      });
    }
  } catch (syncError) {
    logger.warn("answer_sync_failed", {
      shop_id: input.shopId,
      response_id: responseId,
      error_message: syncError instanceof Error ? syncError.message : String(syncError),
    });
  }
}

/** Fill a just-stored Response from an order row that landed meanwhile. */
async function reconcileFromCachedOrder(shopId: string, orderId: string): Promise<void> {
  const order = await retryDb(() =>
    db.orderCache.findUnique({
      where: { shopId_orderId: { shopId, orderId } },
      select: { totalPrice: true, currency: true },
    }),
  );
  if (!order || order.totalPrice === null) return;
  await reconcileOrderForResponses({
    shopId,
    orderId,
    currency: order.currency,
    totalPrice: order.totalPrice.toString(),
  });
}

/**
 * T10: pause a survey once its main question is reliable.
 *
 * Reads the survey's own answers for that question (choice options or numeric
 * values), computes the confidence label, and pauses when the threshold is met.
 * Pausing is an `updateMany` guarded on `status: "active"`, so it fires at most
 * once even under concurrent submissions.
 */
async function maybeLearnAndStop(shopId: string, surveyId: string, questionId: string): Promise<void> {
  const question = await db.question.findFirst({
    where: { id: questionId, surveyId },
    select: { type: true },
  });
  if (!question) return;

  const isNumeric = question.type === "rating_5" || question.type === "nps" || question.type === "satisfaction_5";

  const answers = await db.answer.findMany({
    where: {
      questionId,
      response: { surveyId, shopId, flagged: false },
    },
    select: { optionIds: true, numberValue: true },
  });
  const n = answers.length;

  let topShare = 0;
  if (!isNumeric) {
    const counts = new Map<string, number>();
    for (const answer of answers) {
      const ids = parseJson<string[]>(answer.optionIds, []);
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const top = Math.max(0, ...counts.values());
    topShare = n > 0 ? top / n : 0;
  }

  if (!shouldLearnAndStop({ enabled: true, isNumeric, n, topShare })) return;

  const paused = await db.survey.updateMany({
    where: { id: surveyId, shopId, status: "active" },
    data: { status: "paused" },
  });
  if (paused.count > 0) {
    // Recompile now: the cached config would keep serving the paused survey.
    await invalidateConfig(shopId);
    logger.info("survey_learn_stop_paused", { shop_id: shopId, survey_id: surveyId, answers: n });
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The cached order's total and currency, at its stored precision. Null when the
 * order has not arrived (the answer is stored Pending and reconciled later).
 * A total we could not parse is stored as NULL and never faked as `$0.00`.
 */
async function orderTotalFor(
  shopId: string,
  orderId: string | null,
): Promise<{ decimal: Prisma.Decimal; currency: string } | null> {
  if (!orderId) return null;
  const order = await retryDb(() =>
    db.orderCache.findUnique({
      where: { shopId_orderId: { shopId, orderId } },
      select: { totalPrice: true, currency: true },
    }),
  );
  if (!order || order.totalPrice === null) return null;
  return { decimal: order.totalPrice, currency: order.currency };
}

/**
 * Whether this order already answered, on any survey or surface. Backs the
 * extension's `alreadyAnswered` flag so the Thank-you and Order-status pages
 * stay mutually exclusive.
 */
export async function hasAnyAnswerForOrder(shopId: string, orderId: string): Promise<boolean> {
  // Both stores: a stale single-question client may have answered first.
  const [v2, legacy] = await Promise.all([
    retryDb(() => db.response.count({ where: { shopId, orderId } })),
    retryDb(() => db.surveyResponse.count({ where: { shopId, orderId } })),
  ]);
  return v2 + legacy > 0;
}

/**
 * Attach cached order facts to any v2 `Response` for this order that is still
 * waiting for them, and mark them verified.
 *
 * v2 responses are stored with a null total when the order has not landed. Unlike
 * the legacy `SurveyResponse` (which has `reconciled`/`unreconcilable` columns),
 * the v2 model carries no reconciliation flag — the total itself is the signal —
 * so this is a plain conditional UPDATE. Called from the same place the legacy
 * reconcile runs (`upsertOrderCache`, after the order webhook or backfill writes
 * the row) so a late order is never left Pending forever.
 */
export async function reconcileOrderForResponses(params: {
  shopId: string;
  orderId: string;
  currency: string;
  totalPrice: string;
}): Promise<{ reconciled: number; verified: boolean }> {
  const parsed = parseMoneyToMinor(params.totalPrice, params.currency);
  if (!parsed.ok) return { reconciled: 0, verified: false };
  const decimal = minorToDecimalString(parsed.minor, params.currency);

  const orders = await retryDb(() =>
    db.orderCache.findUnique({
      where: { shopId_orderId: { shopId: params.shopId, orderId: params.orderId } },
      select: { isTest: true, isCancelled: true },
    }),
  );
  const verified = Boolean(orders) && !orders!.isTest && !orders!.isCancelled;

  const result = await retryDb(() =>
    db.response.updateMany({
      where: { shopId: params.shopId, orderId: params.orderId, orderTotal: null },
      // Clear `unverifiedFailed`: the 24h sweep may have written this answer off
      // while its order was missing, and a late order (webhook or dashboard
      // backfill) must recover the revenue rather than leave it excluded forever.
      data: { orderTotal: decimal, currency: params.currency, verified, unverifiedFailed: false },
    }),
  );

  return { reconciled: result.count, verified };
}

/**
 * Mark v2 responses whose order never arrived as `unverifiedFailed`, so they leave
 * the "Pending" set and their (absent) revenue is excluded deliberately rather
 * than by omission. Runs alongside the legacy `markUnreconcilable` sweep.
 */
export async function markUnverifiedFailedResponses(olderThanHours = 24, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanHours * 60 * 60 * 1000);

  // First recover answers whose order IS cached: the webhook's reconcile can
  // miss a row inserted a moment later, and writing those off would exclude an
  // order we hold.
  const recovered = await retryDb(() =>
    db.$executeRaw`
      UPDATE "Response" r
      SET "orderTotal" = o."totalPrice",
          "currency" = o.currency,
          "verified" = (NOT o."isTest" AND NOT o."isCancelled"),
          "unverifiedFailed" = false
      FROM "OrderCache" o
      WHERE o."shopId" = r."shopId" AND o."orderId" = r."orderId"
        AND r."orderTotal" IS NULL
        AND o."totalPrice" IS NOT NULL
    `,
  );
  if (recovered > 0) logger.info("responses_reconciled_late_v2", { count: recovered });

  // Only answers that HAVE an order can wait for one: an on-site or link answer
  // has no order to arrive and is never "unverified failed".
  const result = await retryDb(() =>
    db.response.updateMany({
      where: {
        orderId: { not: null },
        orderTotal: null,
        verified: { not: true },
        unverifiedFailed: false,
        createdAt: { lt: cutoff },
      },
      data: { unverifiedFailed: true },
    }),
  );
  if (result.count > 0) {
    logger.info("responses_marked_unverified_failed", { count: result.count, older_than_hours: olderThanHours });
  }
  return result.count;
}
