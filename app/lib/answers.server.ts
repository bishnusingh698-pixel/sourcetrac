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
import { currentUtcPeriod, evaluateCap, type PlanKey } from "~/lib/plans";
import { withRetry } from "~/lib/retry.server";
import { enqueueSync, hasSyncWork, parseSyncOptions, processPendingSync } from "~/lib/sync.server";
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
  plan: PlanKey;
  definition: SurveyDefinition;
  /** The survey's raw `syncOptions` JSON string, for the optional Phase 7 sync. */
  syncOptions?: string | null;
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

async function incrementUsage(shopId: string): Promise<number> {
  const { periodStart, periodEnd } = currentUtcPeriod();

  return retryDb(async () => {
    await db.billingUsage.upsert({
      where: { shopId_periodStart: { shopId, periodStart } },
      create: { shopId, periodStart, periodEnd, responsesCount: 0 },
      update: {},
    });

    const updated = await db.billingUsage.update({
      where: { shopId_periodStart: { shopId, periodStart } },
      data: { responsesCount: { increment: 1 } },
      select: { responsesCount: true },
    });

    return updated.responsesCount;
  });
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
          flagged: shouldLock,
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
      const usedAfter = await incrementUsage(input.shopId);
      if (!isLocked && evaluateCap(input.plan, usedAfter - 1).shouldFlag) {
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

    // Optional Shopify write-back (Phase 7). Off unless the survey configured
    // it. Recorded, then attempted inline; anything that cannot run yet
    // (order not created, throttled) stays pending for the lazy sweep. This
    // never fails the buyer's submission.
    try {
      const options = parseSyncOptions(input.syncOptions);
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
