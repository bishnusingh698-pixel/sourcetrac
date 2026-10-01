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
  surveyConfig: { capacity: 30, refillPerSecond: 1 } satisfies BucketConfig,
  response: { capacity: 10, refillPerSecond: 1 / 6 } satisfies BucketConfig,
  otherResponse: { capacity: 10, refillPerSecond: 1 / 6 } satisfies BucketConfig,
} as const;

declare global {
  var __sourcetracBuckets: Map<string, Bucket> | undefined;
}

const store: Map<string, Bucket> = globalThis.__sourcetracBuckets ?? new Map();

/** Bound memory: evict idle buckets so a long-lived process cannot grow forever. */
const MAX_BUCKETS = 10_000;
const IDLE_EVICTION_MS = 10 * 60 * 1000;

function evictIdle(nowMs: number): void {
  if (store.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of store) {
    if (nowMs - bucket.lastRefillMs > IDLE_EVICTION_MS) store.delete(key);
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
}

export function bucketCount(): number {
  return store.size;
}

if (globalThis.__sourcetracBuckets === undefined) {
  globalThis.__sourcetracBuckets = store;
}
