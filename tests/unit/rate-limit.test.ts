import { afterEach, describe, expect, it } from "vitest";

import { RateLimitError } from "../../app/lib/errors";
import { BUCKETS, bucketCount, consumeShopBackstop, consumeToken, resetBuckets } from "../../app/lib/rate-limit.server";

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

  it("a drained shop backstop still lets a real order through, and only a real one", async () => {
    // One lifted checkout token used to drain this bucket with made-up ids and
    // 429 every real buyer of the store.
    for (let i = 0; i < BUCKETS.responseShop.capacity; i++) consumeToken("response-shop:v", BUCKETS.responseShop);

    await expect(consumeShopBackstop("response-shop:v", BUCKETS.responseShop, async () => true)).resolves.toBeUndefined();
    await expect(consumeShopBackstop("response-shop:v", BUCKETS.responseShop, async () => false)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("does not evict a busy shop backstop under a flood of distinct keys", () => {
    const now = 3_000_000;
    consumeToken("response-shop:victim", BUCKETS.responseShop, now);
    for (let i = 0; i < 25_000; i++) {
      consumeToken(`k:${i}`, BUCKETS.response, now);
      // The backstop stays in use throughout, as it would under attack.
      if (i % 1000 === 0) consumeToken("response-shop:victim", BUCKETS.responseShop, now);
    }
    // Drain what is left; it must not have been reset to full by eviction.
    let accepted = 0;
    for (let i = 0; i < BUCKETS.responseShop.capacity; i++) {
      try {
        consumeToken("response-shop:victim", BUCKETS.responseShop, now);
        accepted++;
      } catch {
        // limited
      }
    }
    // 26 tokens were spent on it; a reset would leave far more than 80.
    expect(accepted).toBeLessThanOrEqual(BUCKETS.responseShop.capacity - 26);
  });
});
