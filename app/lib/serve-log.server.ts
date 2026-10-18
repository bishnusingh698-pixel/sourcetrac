import type { Placement, TargetingMiss } from "@shared/survey-config";

/**
 * What the checkout blocks were told on the last few page loads, per shop.
 *
 * "The survey doesn't show" had no answer a merchant could find: the block
 * hides itself without a word (it must never show a buyer an error), and the
 * reason lived only in our logs. Each `/api/survey` decision is kept here with
 * the rule that decided it, and the Surveys page lists them as "Recent
 * checkouts", so a merchant who places a test order can see straight away
 * whether the block loaded and, if nothing showed, which setting hid it.
 *
 * In memory on purpose: it is a short diagnostic window, not a record. It holds
 * an order id, a page, a survey id and a reason code; nothing about the buyer
 * beyond the two facts targeting reads (country, first order), both of which
 * an answer stores anyway. Lost on restart, bounded per shop and overall.
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
  placement: Placement;
  orderId: string | null;
  /** The survey shown, or the one whose rule hid it. */
  surveyId: string | null;
  reason: ServeReason;
  pinned: boolean;
  country: string | null;
  isFirstOrder: boolean | null;
};

const PER_SHOP = 20;
const MAX_SHOPS = 2_000;

declare global {
  var __sourcetracServeLog: Map<string, ServeEntry[]> | undefined;
}

const log: Map<string, ServeEntry[]> = globalThis.__sourcetracServeLog ?? new Map();
globalThis.__sourcetracServeLog = log;

export function recordServe(shopId: string, entry: Omit<ServeEntry, "at"> & { at?: Date }): void {
  const { at, ...rest } = entry;
  const list = log.get(shopId) ?? [];
  // A buyer reloading the page asks again with the same answer: keep one line.
  const last = list[0];
  if (last && last.orderId === rest.orderId && last.placement === rest.placement && last.reason === rest.reason) {
    list.shift();
  }
  list.unshift({ ...rest, at: (at ?? new Date()).toISOString() });
  if (list.length > PER_SHOP) list.length = PER_SHOP;
  // Re-insert so the most recently active shops are the last to be evicted.
  log.delete(shopId);
  log.set(shopId, list);
  if (log.size > MAX_SHOPS) {
    const oldest = log.keys().next().value;
    if (oldest !== undefined) log.delete(oldest);
  }
}

export function recentServes(shopId: string): ServeEntry[] {
  return [...(log.get(shopId) ?? [])];
}

/** Test seam. */
export function clearServeLog(): void {
  log.clear();
}
