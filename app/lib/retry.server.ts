/**
 * Retry with exponential backoff and full jitter.
 *
 * "Full jitter" means the sleep is a uniform random draw from [0, backoff]
 * rather than exactly the backoff. Without jitter, every client that failed at
 * the same moment retries at the same moment, which is how a cold-starting
 * backend gets knocked over by a retry stampede.
 */

import { logger } from "./logger";

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Return true to retry. Non-retryable errors short-circuit immediately. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Return true once the caller should stop retrying even if retryable. */
  isAbort?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs = 30_000, random = Math.random): number {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  // Full jitter.
  return Math.floor(random() * exponential);
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    attempts,
    baseDelayMs,
    maxDelayMs = 30_000,
    shouldRetry = () => true,
    isAbort = () => false,
    onRetry,
    random = Math.random,
    sleep = defaultSleep,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Explicit abort (e.g. 401) never retries, no matter the attempt count.
      if (isAbort(error)) throw error;

      const isLast = attempt === attempts;
      if (isLast || !shouldRetry(error, attempt)) break;

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.(error, attempt, delay);
      logger.debug("retry_scheduled", {
        attempt,
        max_attempts: attempts,
        delay_ms: delay,
        error_message: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }

  throw lastError;
}
