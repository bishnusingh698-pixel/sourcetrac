/**
 * GraphQL Admin cost-based throttling: a THROTTLED answer is retried after the
 * time Shopify's own throttle status gives (`extensions.cost.throttleStatus`),
 * and a run of calls to one shop slows down before the bucket is empty.
 * Docs: https://shopify.dev/docs/api/usage/rate-limits
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pacingDelayMs, resetThrottleState, shopifyGraphql, throttleWaitMs } from "~/lib/shopify-graphql.server";

const SHOP = "throttle-test.myshopify.com";

function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => resetThrottleState());
afterEach(() => vi.unstubAllGlobals());

describe("throttleWaitMs", () => {
  it("is the time the bucket needs to refill to the query's cost", () => {
    expect(throttleWaitMs({ requestedQueryCost: 110, throttleStatus: { currentlyAvailable: 10, restoreRate: 100 } })).toBe(1000);
    expect(throttleWaitMs({ requestedQueryCost: 5, throttleStatus: { currentlyAvailable: 10, restoreRate: 100 } })).toBe(0);
  });

  it("never guesses a rate Shopify did not report", () => {
    expect(throttleWaitMs(undefined)).toBeNull();
    expect(throttleWaitMs({ requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 0 } })).toBeNull();
    expect(throttleWaitMs({ requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 0, restoreRate: 0 } })).toBeNull();
  });

  it("caps one wait inside a webhook's five-second budget", () => {
    expect(throttleWaitMs({ requestedQueryCost: 1000, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } })).toBe(4000);
  });
});

describe("shopifyGraphql", () => {
  it("waits out a THROTTLED answer for as long as the throttle status says", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: { requestedQueryCost: 1000, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 1000 } } },
        }),
      )
      .mockResolvedValueOnce(
        reply({ data: { ok: true }, extensions: { cost: { requestedQueryCost: 1, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 1000 } } } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const result = await shopifyGraphql<{ ok: boolean }>(SHOP, "t", "query { ok }");
    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 1000 points short at 1000 points a second: a full second, not a jittered guess.
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("slows the next call down when the last one left the bucket nearly empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({ data: {}, extensions: { cost: { requestedQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 1000 } } } }),
      ),
    );
    await shopifyGraphql(SHOP, "t", "query { a }");
    // 10% headroom of 2000 is 200 points; at 1000 a second that is ~200 ms.
    const pause = pacingDelayMs(SHOP);
    expect(pause).toBeGreaterThan(100);
    expect(pause).toBeLessThanOrEqual(200);
    expect(pacingDelayMs("other-shop.myshopify.com")).toBe(0);
  });
});
