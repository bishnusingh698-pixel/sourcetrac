/**
 * Per-session-token submission limiter.
 *
 * A lifted checkout token must not be reusable to write many forged orders. The
 * limiter is keyed on the token's `jti` and expires at the token's own `exp`, so
 * a re-minted token gets a fresh allowance and the map cannot grow unbounded.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  consumeTokenSubmission,
  MAX_SUBMISSIONS_PER_TOKEN,
  resetBuckets,
} from "~/lib/rate-limit.server";
import { RateLimitError } from "~/lib/errors";

afterEach(() => resetBuckets());

describe("consumeTokenSubmission", () => {
  it("allows up to the ceiling for one token", () => {
    const exp = Date.now() + 300_000;
    for (let i = 0; i < MAX_SUBMISSIONS_PER_TOKEN; i += 1) {
      expect(() => consumeTokenSubmission("tok-a", exp)).not.toThrow();
    }
  });

  it("refuses the submission past the ceiling", () => {
    const exp = Date.now() + 300_000;
    for (let i = 0; i < MAX_SUBMISSIONS_PER_TOKEN; i += 1) consumeTokenSubmission("tok-b", exp);
    expect(() => consumeTokenSubmission("tok-b", exp)).toThrow(RateLimitError);
  });

  it("does not count another token against the first", () => {
    const exp = Date.now() + 300_000;
    consumeTokenSubmission("tok-c", exp);
    consumeTokenSubmission("tok-c", exp);
    expect(() => consumeTokenSubmission("tok-c", exp)).toThrow();
    // A different jti starts fresh.
    expect(() => consumeTokenSubmission("tok-d", exp)).not.toThrow();
  });

  it("forgets an expired token so a re-mint starts fresh", () => {
    const expired = Date.now() - 1000;
    consumeTokenSubmission("tok-e", expired, Date.now() - 2000);
    consumeTokenSubmission("tok-e", expired, Date.now() - 2000);
    // Past the token's exp, the entry is evicted and the allowance resets.
    expect(() => consumeTokenSubmission("tok-e", Date.now() + 300_000)).not.toThrow();
  });
});
