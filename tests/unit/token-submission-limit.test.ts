/**
 * Per-session-token submission limiter.
 *
 * A lifted checkout token must not be reusable to write many forged orders. The
 * limiter is keyed on the token's `jti` and expires at the token's own `exp`, so
 * a re-minted token gets a fresh allowance and the map cannot grow unbounded.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  reserveTokenSubmission,
  MAX_SUBMISSIONS_PER_TOKEN,
  resetBuckets,
} from "~/lib/rate-limit.server";
import { RateLimitError } from "~/lib/errors";

afterEach(() => resetBuckets());

describe("reserveTokenSubmission", () => {
  it("allows up to the ceiling for one token", () => {
    const exp = Date.now() + 300_000;
    for (let i = 0; i < MAX_SUBMISSIONS_PER_TOKEN; i += 1) {
      expect(() => reserveTokenSubmission("tok-a", exp)).not.toThrow();
    }
  });

  it("refuses the submission past the ceiling", () => {
    const exp = Date.now() + 300_000;
    for (let i = 0; i < MAX_SUBMISSIONS_PER_TOKEN; i += 1) reserveTokenSubmission("tok-b", exp);
    expect(() => reserveTokenSubmission("tok-b", exp)).toThrow(RateLimitError);
  });

  it("does not count another token against the first", () => {
    const exp = Date.now() + 300_000;
    reserveTokenSubmission("tok-c", exp);
    reserveTokenSubmission("tok-c", exp);
    expect(() => reserveTokenSubmission("tok-c", exp)).toThrow();
    // A different jti starts fresh.
    expect(() => reserveTokenSubmission("tok-d", exp)).not.toThrow();
  });

  it("forgets an expired token so a re-mint starts fresh", () => {
    const expired = Date.now() - 1000;
    reserveTokenSubmission("tok-e", expired, Date.now() - 2000);
    reserveTokenSubmission("tok-e", expired, Date.now() - 2000);
    // Past the token's exp, the entry is evicted and the allowance resets.
    expect(() => reserveTokenSubmission("tok-e", Date.now() + 300_000)).not.toThrow();
  });
});
