import { db } from "~/db.server";
import { logger } from "~/lib/logger";
import type { Placement } from "@shared/survey-config";

/**
 * Whether the SourceTrac block is really on the merchant's Thank-you page.
 *
 * Shopify exposes no "block added" state and sends no event when a checkout
 * block is placed or removed. A block that asks us for a survey, on a buyer's
 * Thank-you page or inside the checkout editor, is the only proof. The editor
 * reads this so it never tells a merchant their survey is showing in checkout
 * when the block was never added.
 */

/** One write per shop an hour is plenty: only "ever seen" is read. */
const WRITE_INTERVAL_MS = 60 * 60 * 1000;
const lastWrite = new Map<string, number>();

/**
 * Notes that a block on `placement` just asked for a survey. Only the
 * Thank-you page carries a block, so anything else is ignored.
 *
 * Never throws: a buyer's survey must not fail because this bookkeeping did.
 * A failure is logged and retried on the next request.
 */
export async function recordBlockSeen(shopId: string, placement: Placement, now = new Date()): Promise<void> {
  if (placement !== "thank_you") return;
  const last = lastWrite.get(shopId);
  if (last !== undefined && now.getTime() - last < WRITE_INTERVAL_MS) return;
  lastWrite.set(shopId, now.getTime());
  try {
    await db.shop.update({ where: { id: shopId }, data: { thankYouBlockSeenAt: now } });
  } catch (error) {
    lastWrite.delete(shopId);
    logger.warn("block_seen_write_failed", {
      shop_id: shopId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Whether the SourceTrac block has loaded on the Thank-you page since install. */
export async function getBlockSeen(shopId: string): Promise<boolean> {
  const row = await db.shop.findUnique({ where: { id: shopId }, select: { thankYouBlockSeenAt: true } });
  return Boolean(row?.thankYouBlockSeenAt);
}

/**
 * The merchant says the block is on the Thank-you page.
 *
 * A block that has not loaded yet (no order since it was added, or a checkout
 * editor that could not reach us) leaves the warning up although the block is
 * there, so the merchant can clear it themselves.
 */
export async function markBlockAdded(shopId: string, now = new Date()): Promise<void> {
  await db.shop.update({ where: { id: shopId }, data: { thankYouBlockSeenAt: now } });
}

/** Uninstalling removes the app's checkout blocks, so what we saw no longer holds. */
export async function clearBlockSeen(shopId: string): Promise<void> {
  lastWrite.delete(shopId);
  await db.shop.update({ where: { id: shopId }, data: { thankYouBlockSeenAt: null } });
}

/** Test hook: forget the in-process write throttle. */
export function resetBlockSeenThrottle(): void {
  lastWrite.clear();
}
