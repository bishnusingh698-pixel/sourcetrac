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

  // Delete first so the key moves to the end of insertion order. Without it the
  // long-lived shop-wide backstops were the OLDEST keys and the first to be
  // dropped by the hard-limit eviction above, so a flood of distinct per-order
  // keys reset the very bucket meant to stop that flood.
  store.delete(key);
  store.set(key, { tokens: refilled - 1, lastRefillMs: now });
}

/**
 * Consume from a shop-wide backstop, but never let it refuse an order Shopify
 * actually told us about.
 *
 * The backstop is keyed only on the store, and anyone who bought once can
 * re-mint a valid checkout token forever. Draining it with made-up order ids
 * used to return 429 to every real buyer of that store, whose answers were then
 * lost once the extension's retry budget ran out. Made-up ids are never in the
 * order cache, so they stay throttled; a real order goes through.
 *
 * `isKnownOrder` is only consulted once the bucket is empty, so normal traffic
 * pays no extra query.
 */
export async function consumeShopBackstop(
  key: string,
  config: BucketConfig,
  isKnownOrder: () => Promise<boolean>,
): Promise<void> {
  try {
    consumeToken(key, config);
  } catch (error) {
    if (error instanceof RateLimitError && (await isKnownOrder())) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Per-session-token submission limiter
// ---------------------------------------------------------------------------

/**
 * How many responses one checkout session token may submit.
 *
 * The per-order bucket is keyed on a value the caller chooses, so one valid
 * token (anyone who has bought from the store) plus a made-up order id each time
 * got a fresh bucket and could write unlimited forged answers, poisoning the
 * merchant's channel and revenue report and burning their free-tier cap. A real
 * buyer answers at most two surfaces (Thank-you and Order-status) for one order,
 * so a ceiling of a few is generous.
 */
export const MAX_SUBMISSIONS_PER_TOKEN = 2;

type TokenEntry = { count: number; expiresAt: number };

declare global {
  var __sourcetracTokenSubs: Map<string, TokenEntry> | undefined;
}

const tokenSubs: Map<string, TokenEntry> = globalThis.__sourcetracTokenSubs ?? new Map();

/** Drop expired token entries. Cheap: bounded by the session-token TTL. */
function evictExpiredTokenSubs(nowMs: number): void {
  if (tokenSubs.size === 0) return;
  for (const [key, entry] of tokenSubs) {
    if (entry.expiresAt <= nowMs) tokenSubs.delete(key);
  }
}

/**
 * Count a submission against a session token, refusing past the ceiling.
 *
 * Keyed on the token's `jti` (a per-token UUID, present on every Shopify session
 * token) and expiring at the token's own `exp`, so the map cannot grow without
 * bound and a re-minted token gets a fresh allowance. In-memory like the rest of
 * this module: correct for the single Render instance, and a deliberate,
 * documented trade for any future scale-out.
 */
export function consumeTokenSubmission(
  tokenKey: string,
  expiresAtMs: number,
  now = Date.now(),
): void {
  checkTokenSubmission(tokenKey, now);
  recordTokenSubmission(tokenKey, expiresAtMs, now);
}

/**
 * Refuse a token that has already written its allowance, without counting this
 * attempt. Called before any database read; `recordTokenSubmission` counts only
 * an answer that was actually stored, so failed attempts (a 5xx while the
 * database wakes, a backstop 429 before the order lands) never burn the cap and
 * lock a real buyer out of their own retries.
 */
export function checkTokenSubmission(tokenKey: string, now = Date.now()): void {
  evictExpiredTokenSubs(now);
  const existing = tokenSubs.get(tokenKey);
  if (existing && existing.expiresAt > now && existing.count >= MAX_SUBMISSIONS_PER_TOKEN) {
    throw new RateLimitError(60, { bucket: "token" });
  }
}

/** Count one stored answer against the token. */
export function recordTokenSubmission(tokenKey: string, expiresAtMs: number, now = Date.now()): void {
  const existing = tokenSubs.get(tokenKey);
  if (!existing || existing.expiresAt <= now) {
    tokenSubs.set(tokenKey, { count: 1, expiresAt: expiresAtMs });
    return;
  }
  existing.count += 1;
}

/** Test helper: clear all buckets. */
export function resetBuckets(): void {
  store.clear();
  tokenSubs.clear();
  lastSweepMs = Number.NEGATIVE_INFINITY;
}

export function bucketCount(): number {
  return store.size;
}

if (globalThis.__sourcetracBuckets === undefined) {
  globalThis.__sourcetracBuckets = store;
}
