import { createHash } from "node:crypto";

import { db, isRetryableDbError } from "~/db.server";
import { logger } from "~/lib/logger";
import { withRetry } from "~/lib/retry.server";
import { TRIAL_DAYS, type PlanKey } from "~/lib/plans";

/**
 * The 14-day free trial on Growth and Scale, one per store, ever.
 *
 * Shopify runs the trial itself: `appSubscriptionCreate(trialDays:)` delays the
 * first charge, the merchant sees the trial on Shopify's approval page, and a
 * subscription cancelled before it ends is never billed. What Shopify does not
 * do for the Billing API is remember that a store already had one: a new
 * subscription created with `trialDays: 14` gets 14 days, whether it follows an
 * uninstall, a cancellation or a plan switch. So the app keeps that record:
 *
 * - `TrialLedger` holds one row per store that has ever had a paid
 *   subscription, keyed by hashes of its domain and GID, unlinked from `Shop`
 *   so an uninstall or `shop/redact` cannot reset it.
 * - The row is written the first time a paid subscription is seen live, from
 *   that subscription's own `createdAt` and `trialDays`, and never changed.
 * - A new subscription gets the days left until that fixed end (rounded up to
 *   a whole day, Shopify's unit): 14 for a store that never had one, the rest
 *   when it switches plan or cycle during the trial, 0 after.
 *
 * The trial starts at `createdAt`, the moment the charge was created, which is
 * at most the approval delay before Shopify's own start. The end shown to the
 * merchant is therefore never later than Shopify's, so "you won't be charged
 * before <date>" is always true.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = "sourcetrac-trial:";

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, { attempts: 3, baseDelayMs: 250, shouldRetry: isRetryableDbError });
}

function hashKey(value: string): string {
  return createHash("sha256").update(KEY_PREFIX + value).digest("hex");
}

/** The ledger key of a myshopify domain. */
export function trialDomainKey(shopDomain: string): string {
  return hashKey(shopDomain.trim().toLowerCase());
}

/** The ledger key of a shop GID, or null for the placeholder id a failed lookup leaves. */
export function trialShopKey(shopGid: string | null | undefined): string | null {
  return shopGid && shopGid.startsWith("gid://shopify/Shop/") ? hashKey(shopGid) : null;
}

export type TrialRecord = { startedAt: Date; endsAt: Date; plan: string };

/** This store's trial record, by domain or GID; null when it never had a paid plan. */
export async function findTrial(shop: { shopDomain: string; shopId?: string | null }): Promise<TrialRecord | null> {
  const shopKey = trialShopKey(shop.shopId);
  const row = await retryDb(() =>
    db.trialLedger.findFirst({
      where: { OR: [{ domainKey: trialDomainKey(shop.shopDomain) }, ...(shopKey ? [{ shopKey }] : [])] },
      orderBy: { startedAt: "asc" },
    }),
  );
  return row ? { startedAt: row.startedAt, endsAt: row.endsAt, plan: row.plan } : null;
}

/**
 * Whole trial days a NEW subscription gets: the full trial for a store that
 * never had a paid plan, the days left (rounded up) during the trial, 0 after.
 * Computed from the ledger's fixed end, so switching repeatedly can never add
 * more than the part of one day the rounding gives.
 */
export function remainingTrialDays(trial: Pick<TrialRecord, "endsAt"> | null, now = new Date()): number {
  if (!trial) return TRIAL_DAYS;
  const left = trial.endsAt.getTime() - now.getTime();
  if (left <= 0) return 0;
  return Math.min(TRIAL_DAYS, Math.ceil(left / DAY_MS));
}

/** When a subscription's own trial ends; null when it has none or Shopify sent no date. */
export function subscriptionTrialEnd(subscription: { trialDays?: number | null; createdAt?: string | null }): Date | null {
  const days = subscription.trialDays ?? 0;
  if (!(days > 0) || !subscription.createdAt) return null;
  const created = new Date(subscription.createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return new Date(created.getTime() + days * DAY_MS);
}

/**
 * A paid SourceTrac subscription is live: record the store's trial (first
 * time only) and the end of this subscription's own trial on the shop.
 *
 * Idempotent and safe to call on every Plans page load and every ACTIVE
 * notice. Never throws: the plan itself is decided elsewhere, and a failed
 * bookkeeping write must not fail a billing webhook or the page (it is
 * retried on the next one).
 */
export async function noteLiveSubscription(params: {
  shopInternalId: string;
  shopDomain: string;
  shopGid?: string | null;
  plan: PlanKey;
  subscription: { trialDays?: number | null; createdAt?: string | null };
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  try {
    const created = params.subscription.createdAt ? new Date(params.subscription.createdAt) : null;
    const startedAt = created && !Number.isNaN(created.getTime()) ? created : now;
    const ownEnd = subscriptionTrialEnd(params.subscription);
    const domainKey = trialDomainKey(params.shopDomain);
    const shopKey = trialShopKey(params.shopGid);

    // First paid subscription ever: its trial (or none, for a subscription
    // created before trials existed) is the store's one trial.
    const existing = await findTrial({ shopDomain: params.shopDomain, shopId: params.shopGid });
    if (!existing && params.plan !== "free") {
      await retryDb(() =>
        db.trialLedger
          .create({
            data: { domainKey, shopKey, startedAt, endsAt: ownEnd ?? startedAt, plan: params.plan },
          })
          // Two notices racing (the webhook and the billing return) both found
          // no row; the unique key keeps the first, which is the same trial.
          .catch((error: unknown) => {
            if ((error as { code?: string })?.code === "P2002") return null;
            throw error;
          }),
      );
    } else if (existing && shopKey) {
      // Learn the GID key once it is known, so a later domain change still matches.
      // Best effort: the domain key already matches; a failure is logged and
      // the next notice or page load tries again.
      await retryDb(() =>
        db.trialLedger.updateMany({ where: { domainKey, shopKey: null }, data: { shopKey } }),
      ).catch((error: unknown) => {
        logger.warn("trial_shop_key_update_failed", {
          shop_id: params.shopInternalId,
          error_message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    await retryDb(() =>
      db.shop.updateMany({ where: { id: params.shopInternalId }, data: { trialEndsAt: ownEnd } }),
    );
  } catch (error) {
    logger.error("trial_note_failed", {
      shop_id: params.shopInternalId,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}
