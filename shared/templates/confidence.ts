/**
 * Confidence meter (T9) and the learn-&-stop threshold (T10).
 *
 * Applied to a survey's MAIN question (the first choice/score question). The
 * margin of error for a proportion is `1.96 * sqrt(p*(1-p)/n)`. A raw statistic
 * is never shown to the merchant — only a plain-language label — but the label
 * is derived from it, and every boundary is unit-tested.
 *
 * Dependency-free.
 */

import type { ConfidenceLevel } from "./ideas";

/** n below this is always "Too early", regardless of the margin of error. */
export const MIN_ANSWERS = 30;

/** Margin-of-error thresholds, as fractions (15% = 0.15). */
export const MOE_EARLY_SIGNAL = 0.15;
export const MOE_GETTING_CLEAR = 0.1;

/** T10: pause once a choice main question is Reliable AND n >= this. */
export const LEARN_STOP_MIN_ANSWERS = 100;
/** T10: rating/NPS main questions use this instead of the MoE rule. */
export const LEARN_STOP_MIN_NUMERIC = 150;

/**
 * Margin of error of the top answer's share, as a fraction. Null when there are
 * no answers or the share is undefined.
 */
export function marginOfError(n: number, topShare: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Math.min(Math.max(topShare, 0), 1);
  return 1.96 * Math.sqrt((p * (1 - p)) / n);
}

/**
 * The confidence label for a choice question's results.
 *
 * `topShare` is the share (0–1) of the most-chosen option.
 */
export function confidenceFor(n: number, topShare: number): ConfidenceLevel {
  if (!Number.isFinite(n) || n < MIN_ANSWERS) return "too_early";
  const moe = marginOfError(n, topShare);
  if (moe === null) return "too_early";
  if (moe > MOE_EARLY_SIGNAL) return "early_signal";
  if (moe > MOE_GETTING_CLEAR) return "getting_clear";
  return "reliable";
}

/** Confidence for a rating/NPS main question, from its answer count alone. */
export function confidenceForNumeric(n: number): ConfidenceLevel {
  if (!Number.isFinite(n) || n < MIN_ANSWERS) return "too_early";
  if (n < 60) return "early_signal";
  if (n < 100) return "getting_clear";
  return "reliable";
}

/**
 * Whether learn & stop should pause the survey now (T10).
 *
 * Choice questions need "reliable" AND n >= 100; rating/NPS need n >= 150.
 * Returns false when the exact trigger has not been reached, so the caller
 * pauses at most once (pausing removes the survey from the active set).
 */
export function shouldLearnAndStop(params: {
  enabled: boolean;
  isNumeric: boolean;
  n: number;
  topShare: number;
}): boolean {
  if (!params.enabled) return false;
  if (params.isNumeric) {
    return params.n >= LEARN_STOP_MIN_NUMERIC;
  }
  return params.n >= LEARN_STOP_MIN_ANSWERS && confidenceFor(params.n, params.topShare) === "reliable";
}
