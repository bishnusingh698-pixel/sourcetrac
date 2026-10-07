/**
 * In-memory token-bucket rate limiting for the public extension endpoints.
 *
 * In-memory is a deliberate trade: SourceTrac runs as a single Render
 * instance, so a shared store would be infrastructure for no benefit. The
 * consequence is that limits reset when the process restarts, which is
 * acceptable for abuse mitigation and documented rather than hidden.
 *
 * If the app is ever scaled horizontally this MUST move to a shared store,
 * otherwise the effective limit multiplies by the instance count.
 */

import { RateLimitError } from "./errors";

export type BucketConfig = {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
};

export type Bucket = {
  tokens: number;
  lastRefillMs: number;
};

/**
 * A buyer generates 2 requests (config + response), plus one more if they use
 * the "Other" box. Ten per minute tolerates bursty checkout traffic while
 * stopping scripted abuse.
 */
export const BUCKETS = {
  /** Per order: one buyer reloading the page. */
  surveyConfig: { capacity: 30, refillPerSecond: 1 } satisfies BucketConfig,
  response: { capacity: 10, refillPerSecond: 1 / 6 } satisfies BucketConfig,
  otherResponse: { capacity: 10, refillPerSecond: 1 / 6 } satisfies BucketConfig,
  /**
   * Per shop, across every order.
   *
   * The per-order buckets alone are keyed on a value the caller chooses: one
   * valid checkout token (anyone who has bought from the store can lift it from
   * the extension) plus a fresh made-up order id each time gets a fresh bucket,
   * so a script could write unlimited fake answers. That poisons the merchant's
   * channel analytics, burns their free-tier cap, and fills the database.
   *
   * These ceilings sit far above real traffic for the target merchants (up to
   * ~2,000 orders a month, so a flash sale of a few hundred an hour) and bound
   * what one forged identity can do.
   */
  responseShop: { capacity: 100, refillPerSecond: 1 / 20 } satisfies BucketConfig,
  surveyConfigShop: { capacity: 300, refillPerSecond: 2 } satisfies BucketConfig,
} as const;

declare global {
  var __sourcetracBuckets: Map<string, Bucket> | undefined;
}

const store: Map<string, Bucket> = globalThis.__sourcetracBuckets ?? new Map();

/** Bound memory: evict idle buckets so a long-lived process cannot grow forever. */
const MAX_BUCKETS = 10_000;
const IDLE_EVICTION_MS = 10 * 60 * 1000;

/**
 * When the last full sweep ran. A sweep walks the whole map, so running one on
 * every request past the soft limit made each request O(n) — under a flood of
 * distinct keys that is itself a CPU denial of service. Sweeps are throttled
 * to once a second unless the hard limit is hit.
 */
let lastSweepMs = Number.NEGATIVE_INFINITY;

function evictIdle(nowMs: number): void {
  if (store.size <= MAX_BUCKETS) return;
  if (store.size <= MAX_BUCKETS * 2 && nowMs - lastSweepMs < 1000) return;
  lastSweepMs = nowMs;
  for (const [key, bucket] of store) {
    if (nowMs - bucket.lastRefillMs > IDLE_EVICTION_MS) store.delete(key);
  }
  // Idle eviction alone cannot bound memory: a flood of distinct keys inside
  // the idle window leaves nothing old enough to drop. Past twice the soft
  // limit, drop the oldest-inserted buckets outright. Forgetting a bucket only
  // ever resets it to full, which errs toward letting a real buyer through.
  if (store.size <= MAX_BUCKETS * 2) return;
  for (const key of store.keys()) {
    if (store.size <= MAX_BUCKETS) break;
    store.delete(key);
  }
}

export function consumeToken(key: string, config: BucketConfig, now = Date.now()): void {
  evictIdle(now);

  const existing = store.get(key);
  if (!existing) {
    store.set(key, { tokens: config.capacity - 1, lastRefillMs: now });
    return;
  }

  const elapsedSeconds = Math.max(0, (now - existing.lastRefillMs) / 1000);
  const refilled = Math.min(config.capacity, existing.tokens + elapsedSeconds * config.refillPerSecond);

  if (refilled < 1) {
    // Seconds until one whole token is available.
    const waitSeconds = Math.ceil((1 - refilled) / config.refillPerSecond);
    throw new RateLimitError(Math.max(1, waitSeconds), { bucket: key });
  }

  store.set(key, { tokens: refilled - 1, lastRefillMs: now });
}

/** Test helper: clear all buckets. */
export function resetBuckets(): void {
  store.clear();
  lastSweepMs = Number.NEGATIVE_INFINITY;
}

export function bucketCount(): number {
  return store.size;
}

if (globalThis.__sourcetracBuckets === undefined) {
  globalThis.__sourcetracBuckets = store;
}
