import { afterEach, describe, expect, it } from "vitest";

import { BUCKETS, bucketCount, consumeToken, resetBuckets } from "../../app/lib/rate-limit.server";

afterEach(() => resetBuckets());

describe("rate limiting", () => {
  it("caps a shop's writes even when every request uses a new order id", () => {
    // The per-order bucket is keyed on a caller-chosen value, so only the
    // shop-wide bucket can stop a flood of made-up order ids.
    const now = 1_000_000;
    let accepted = 0;
    for (let i = 0; i < BUCKETS.responseShop.capacity + 50; i++) {
      try {
        consumeToken("response-shop:x.myshopify.com", BUCKETS.responseShop, now);
        consumeToken(`response:x.myshopify.com:${i}`, BUCKETS.response, now);
        accepted++;
      } catch {
        // rate limited
      }
    }
    expect(accepted).toBe(BUCKETS.responseShop.capacity);
  });

  it("keeps the bucket store bounded under a burst of distinct keys", () => {
    const now = 2_000_000;
    for (let i = 0; i < 25_000; i++) consumeToken(`k:${i}`, BUCKETS.response, now);
    expect(bucketCount()).toBeLessThanOrEqual(20_000);
  });
});
