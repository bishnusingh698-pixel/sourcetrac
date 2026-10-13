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
import { enqueueSync, hasSyncWork, parseSyncOptions, processPendingSync } from "~/lib/sync.server";
import { shouldLearnAndStop } from "@shared/templates/confidence";
import {
  isQuestionVisible,
  OTHER_CHANNEL_VALUE,
  validateResponse,
  type AnswerInput,
  type SurveyDefinition,
} from "@shared/survey-rules";
import type { Placement } from "@shared/survey-config";

export type AnswerSubmitInput = {
  shopId: string;
  surveyId: string;
  surveyVersion: number;
  orderId: string | null;
  placement: Placement;
  locale: string | null;
  answers: AnswerInput[];
  /** T8: product ids on the order's lines, for results by product. */
  productIds?: string[];
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
 * The increment is a single conditional UPDATE, so Postgres serialises it and
 * exactly one request can take the last slot. Returns `{ count, withinCap }`
 * where `count` is this answer's true position and `withinCap` is false when it
 * landed at or past the cap (the answer is still stored, just flagged).
 */
export async function claimUsageSlot(shopId: string, cap: number | null): Promise<{ count: number; withinCap: boolean }> {
  const { periodStart, periodEnd } = currentUtcPeriod();

  return retryDb(async () => {
    // Insert-or-ignore rather than `upsert`: Prisma's `upsert` is a
    // select-then-insert under the hood, so twenty simultaneous first-of-month
    // claims raced and one lost with a P2002. A single `ON CONFLICT DO NOTHING`
    // lets the database arbitrate. The id is generated here because the column
    // has no database-side default (Prisma supplies cuids client-side).
    const id = `usage_${randomId()}`;
    await db.$executeRaw`
      INSERT INTO "BillingUsage" ("id", "shopId", "periodStart", "periodEnd", "responsesCount", "cap", "updatedAt")
      VALUES (${id}, ${shopId}, ${periodStart}, ${periodEnd}, 0, ${cap}, now())
      ON CONFLICT ("shopId", "periodStart") DO NOTHING
    `;

    const rows = await db.$queryRaw<Array<{ responsesCount: number }>>`
      UPDATE "BillingUsage"
      SET "responsesCount" = "responsesCount" + 1,
          "cap" = ${cap},
          "updatedAt" = now()
      WHERE "shopId" = ${shopId}
        AND "periodStart" = ${periodStart}
        AND (${cap}::int IS NULL OR "responsesCount" < ${cap})
      RETURNING "responsesCount"
    `;

    if (rows.length > 0) {
      return { count: rows[0]!.responsesCount, withinCap: true };
    }

    // The conditional UPDATE matched nothing: the cap is reached. Read the true
    // count so the caller can still report volume honestly.
    const current = await db.billingUsage.findUnique({
      where: { shopId_periodStart: { shopId, periodStart } },
      select: { responsesCount: true },
    });
    return { count: (current?.responsesCount ?? 0) + 1, withinCap: false };
  });
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
 * Validation runs here as well as in the route: the route validates against the
 * compiled config the buyer answered from, but between that read and this write
 * the merchant can edit the survey, so the definition is re-checked under the
 * same rules before anything is stored. An invalid submission is refused; it is
 * never partially written.
 */
export async function submitAnswers(input: AnswerSubmitInput): Promise<AnswerSubmitResult> {
  const issues = validateResponse(input.definition, input.answers);
  if (issues.length > 0) {
    return { outcome: "invalid", issues: issues.map((i) => `${i.path}: ${i.code}`) };
  }

  const usedBefore = await getUsageCount(input.shopId);
  const capStatus = evaluateCap(input.plan, usedBefore);
  const shouldLock = capStatus.shouldFlag;

  const { channel, otherText } = channelAnswer(input.definition, input.answers);
  const orderTotal = await orderTotalFor(input.shopId, input.orderId);

  // Order verification: a known, countable order is "verified"; anything else is
  // unverified and its revenue only counts once the order webhook (or the
  // backfill) lands and stores the real total. `verified` is a snapshot; the
  // authoritative revenue decision is still `decideSurveyRevenue` at read time.
  const verified = await isCountableOrder(input.shopId, input.orderId);

  try {
    const created = await retryDb(() =>
      db.response.create({
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
          flagged: shouldLock,
          verified,
          // The legacy channel column lives on SurveyResponse, not Response;
          // the new model keeps the channel in the Answer row. `channel`/`
          // otherText` are stored here only to keep the compiled channel report
          // cheap to query alongside the answer rows.
          answers: {
            create: input.answers.map((answer) => ({
              shopId: input.shopId,
              questionId: answer.questionId,
              optionIds: JSON.stringify(answer.optionIds ?? []),
              numberValue: answer.numberValue ?? null,
              textValue: answer.textValue?.slice(0, 500) ?? null,
              otherText: answer.otherText?.slice(0, 500) ?? null,
            })),
          },
        },
        select: { id: true, flagged: true },
      }),
    );

    let isLocked = created.flagged;
    try {
      // Atomic claim so 20 simultaneous submissions cannot exceed the cap: the
      // conditional UPDATE lets exactly one take the last slot.
      const claimed = await claimUsageSlot(input.shopId, capOf(input.plan));
      if (!isLocked && !claimed.withinCap) {
        await retryDb(() => db.response.update({ where: { id: created.id }, data: { flagged: true } }));
        isLocked = true;
      }
    } catch (usageError) {
      logger.warn("answer_usage_increment_failed", {
        shop_id: input.shopId,
        response_id: created.id,
        error_message: usageError instanceof Error ? usageError.message : String(usageError),
      });
    }

    await bumpSurveyResponseCount(input.surveyId);

    // T10: Learn & stop. Once this response makes the main question reliable,
    // pause the survey. The pause lives in the same path as a manual pause, and
    // recompiling the config is what makes shoppers stop seeing it. Best-effort:
    // a failure here must never fail the buyer's submission.
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

    // Optional Shopify write-back (Phase 7). Off unless the survey configured
    // it. Recorded, then attempted inline; anything that cannot run yet
    // (order not created, throttled) stays pending for the lazy sweep. This
    // never fails the buyer's submission.
    try {
      const options = parseSyncOptions(input.syncOptions);
      // T13 smart actions are Pro-only. A downgraded shop may still carry the
      // presets in its stored config, so drop them unless the plan grants them.
      if (input.plan !== "scale" && options.presets) {
        delete options.presets;
      }
      if (hasSyncWork(options)) {
        await enqueueSync(input.shopId, created.id, options);
        await processPendingSync(input.shopId, 5);
      }
    } catch (syncError) {
      logger.warn("answer_sync_failed", {
        shop_id: input.shopId,
        response_id: created.id,
        error_message: syncError instanceof Error ? syncError.message : String(syncError),
      });
    }

    logger.info("answer_created", {
      shop_id: input.shopId,
      survey_id: input.surveyId,
      response_id: created.id,
      channel,
      is_locked: isLocked,
      answer_count: input.answers.length,
    });

    return { outcome: "created", id: created.id, isLocked, counted: !isLocked };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A duplicate is a success. When there is no order id (on-site/link) the
      // unique constraint cannot apply, so this is only reached for orders.
      const existing = input.orderId
        ? await retryDb(() =>
            db.response.findFirst({
              where: { shopId: input.shopId, surveyId: input.surveyId, orderId: input.orderId },
              select: { id: true, flagged: true },
            }),
          )
        : null;

      if (existing) {
        logger.info("answer_duplicate_ignored", {
          shop_id: input.shopId,
          survey_id: input.surveyId,
          response_id: existing.id,
        });
        return { outcome: "duplicate", id: existing.id, isLocked: existing.flagged, counted: !existing.flagged };
      }

      logger.warn("answer_duplicate_row_missing", {
        shop_id: input.shopId,
        survey_id: input.surveyId,
        order_id: input.orderId,
      });
      return { outcome: "duplicate", id: "", isLocked: shouldLock, counted: !shouldLock };
    }

    throw error;
  }
}

/** Keep the denormalised per-survey count in step with the response rows. */
async function bumpSurveyResponseCount(surveyId: string): Promise<void> {
  await retryDb(() => db.survey.update({ where: { id: surveyId }, data: { responseCount: { increment: 1 } } }));
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
  const count = await retryDb(() => db.response.count({ where: { shopId, orderId } }));
  return count > 0;
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
      data: { orderTotal: decimal, currency: params.currency, verified },
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
  const result = await retryDb(() =>
    db.response.updateMany({
      where: { orderTotal: null, verified: { not: true }, unverifiedFailed: false, createdAt: { lt: cutoff } },
      data: { unverifiedFailed: true },
    }),
  );
  if (result.count > 0) {
    logger.info("responses_marked_unverified_failed", { count: result.count, older_than_hours: olderThanHours });
  }
  return result.count;
}
