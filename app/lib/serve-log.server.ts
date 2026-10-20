import { db } from "~/db.server";
import { isRedactedOrder } from "~/lib/compliance.server";
import { logger } from "~/lib/logger";
import type { Placement, TargetingMiss } from "@shared/survey-config";
import { isCheckoutPlacement, type CheckoutPlacement } from "~/lib/block-seen.server";

/**
 * "Recent checkouts": what the checkout blocks (Thank-you and Order status) were
 * told on their last page loads, per shop.
 *
 * "The survey doesn't show" had no answer a merchant could find: the block
 * hides itself without a word (it must never show a buyer an error), and the
 * reason lived only in our logs. Each `/api/survey` decision is stored with the
 * rule that decided it, and the Surveys page lists the newest ones, so a
 * merchant who places a test order sees straight away whether the block loaded
 * and, if nothing showed, which setting hid it ("this order already answered"
 * is the usual one).
 *
 * In the database, not memory: an in-memory list was wiped by every restart
 * and deploy, which is exactly when a merchant tests. Bounded to `PER_SHOP`
 * rows per shop and 30 days (retention). It holds an order id, a survey id, a
 * reason code and the two facts targeting reads (country, first order), both of
 * which an answer stores anyway.
 */

export type ServeReason =
  | "shown"
  | "already_answered"
  | "none_live"
  | "not_on_page"
  | "pinned_not_live"
  | "pinned_other_page"
  | "payment_rule"
  | TargetingMiss;

export type ServeEntry = {
  at: string;
  placement: CheckoutPlacement;
  orderId: string | null;
  /** The survey shown, or the one whose rule hid it. */
  surveyId: string | null;
  reason: ServeReason;
  pinned: boolean;
  country: string | null;
  isFirstOrder: boolean | null;
};

/** How many loads the Surveys page lists, and the most kept per shop. */
export const PER_SHOP = 20;
export const CHECKOUT_LOAD_RETENTION_DAYS = 30;

/** Writes still in flight, so tests can wait for them (`flushServeLog`). */
const pending = new Set<Promise<void>>();

/**
 * Records one checkout page decision. Never throws and is not awaited by the
 * route: a buyer's survey must not wait on, or fail because of, this
 * bookkeeping. Pages with no checkout block are ignored.
 */
export function recordServe(
  shopId: string,
  entry: Omit<ServeEntry, "at" | "placement"> & { placement: Placement; at?: Date },
): Promise<void> {
  const { at, placement, ...rest } = entry;
  if (!isCheckoutPlacement(placement)) return Promise.resolve();
  const write = (async () => {
    try {
      // An order a customer asked to have redacted is never recorded again.
      if (rest.orderId && (await isRedactedOrder(shopId, rest.orderId))) return;
      // A buyer reloading the page asks again with the same answer: keep one
      // line, moved to the top.
      if (rest.orderId) {
        await db.checkoutLoad.deleteMany({ where: { shopId, placement, orderId: rest.orderId, reason: rest.reason } });
      }
      await db.checkoutLoad.create({ data: { shopId, placement, ...rest, ...(at ? { at } : {}) } });
      const stale = await db.checkoutLoad.findMany({
        where: { shopId },
        orderBy: { at: "desc" },
        skip: PER_SHOP,
        select: { id: true },
      });
      if (stale.length > 0) await db.checkoutLoad.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    } catch (error) {
      logger.warn("checkout_load_write_failed", {
        shop_id: shopId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  pending.add(write);
  void write.finally(() => pending.delete(write));
  return write;
}

/** The newest checkout page loads, newest first. */
export async function recentServes(shopId: string): Promise<ServeEntry[]> {
  const rows = await db.checkoutLoad.findMany({ where: { shopId }, orderBy: { at: "desc" }, take: PER_SHOP });
  return rows.map((row) => ({
    at: row.at.toISOString(),
    placement: row.placement === "order_status" ? "order_status" : "thank_you",
    orderId: row.orderId,
    surveyId: row.surveyId,
    reason: row.reason as ServeReason,
    pinned: row.pinned,
    country: row.country,
    isFirstOrder: row.isFirstOrder,
  }));
}

/** Test seam: wait for every write `recordServe` started. */
export async function flushServeLog(): Promise<void> {
  await Promise.all([...pending]);
}
