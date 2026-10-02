import { describe, expect, it } from "vitest";

import { buildTrend, computeStats, previousWindowBounds, toUtcDateKey, windowBounds } from "~/lib/analytics";
import { CAP_WARNING_RATIO, currentUtcPeriod, evaluateCap, isPlanKey, planFor } from "~/lib/plans";

/**
 * The dashboard is where a wrong number becomes a wrong marketing decision, so
 * these cover the shapes that are easy to get subtly wrong: empty data, divide
 * by zero, day boundaries and multi-currency.
 */

const NOW = new Date("2026-10-15T12:00:00.000Z");

const response = (overrides: Partial<Parameters<typeof computeStats>[0]["responses"][number]> = {}) => ({
  channel: "instagram",
  submittedAt: new Date("2026-10-10T09:00:00.000Z"),
  isLocked: false,
  reconciled: true,
  unreconcilable: false,
  ...overrides,
});

const amount = (overrides: Partial<Parameters<typeof computeStats>[0]["decidedAmounts"][number]> = {}) => ({
  channel: "instagram",
  currency: "USD",
  minor: 10000,
  submittedAt: new Date("2026-10-10T09:00:00.000Z"),
  ...overrides,
});

describe("computeStats", () => {
  it("returns an empty summary with no responses and no divide-by-zero", () => {
    const { summary } = computeStats({ responses: [], decidedAmounts: [], ordersInWindow: 0 });
    expect(summary.totalResponses).toBe(0);
    expect(summary.revenueByCurrency).toEqual([]);
    expect(summary.aovByCurrency).toEqual([]);
    expect(summary.responseRate).toBeNull();
  });

  it("computes response rate against eligible orders", () => {
    const { summary } = computeStats({
      responses: [response(), response({ channel: "google" })],
      decidedAmounts: [],
      ordersInWindow: 10,
    });
    expect(summary.responseRate).toBeCloseTo(20);
  });

  it("returns a null response rate when there are no orders, never Infinity", () => {
    const { summary } = computeStats({
      responses: [response()],
      decidedAmounts: [],
      ordersInWindow: 0,
    });
    expect(summary.responseRate).toBeNull();
  });

  it("keeps revenue separated by currency", () => {
    const { summary } = computeStats({
      responses: [response(), response()],
      decidedAmounts: [amount({ minor: 10000, currency: "USD" }), amount({ minor: 9000, currency: "EUR" })],
      ordersInWindow: 2,
    });
    expect(summary.revenueByCurrency).toHaveLength(2);
  });

  it("omits AOV for a currency with responses but no decided revenue", () => {
    const { summary } = computeStats({
      responses: [response()],
      decidedAmounts: [],
      ordersInWindow: 1,
    });
    expect(summary.aovByCurrency).toEqual([]);
  });

  it("counts locked responses separately from total", () => {
    const { summary } = computeStats({
      responses: [response({ isLocked: true }), response()],
      decidedAmounts: [],
      ordersInWindow: 2,
    });
    expect(summary.totalResponses).toBe(2);
    expect(summary.lockedResponses).toBe(1);
  });

  it("counts an unreconciled response as pending, not as zero revenue", () => {
    const { summary } = computeStats({
      responses: [response({ reconciled: false })],
      decidedAmounts: [],
      ordersInWindow: 1,
    });
    expect(summary.pendingResponses).toBe(1);
    expect(summary.revenueByCurrency).toEqual([]);
  });

  it("divides AOV only by orders that contributed revenue, not by all responses", () => {
    // Three responses: one normal $100 order, one fully refunded and one test
    // order. Both of the latter are excluded by evaluateRevenue but are NOT
    // "pending", so a denominator of totalResponses - pendingResponses would
    // report $33.33 instead of the correct $100.00.
    const { summary } = computeStats({
      responses: [response(), response(), response()],
      decidedAmounts: [amount({ minor: 10000 })],
      ordersInWindow: 3,
    });

    expect(summary.pendingResponses).toBe(0);
    expect(summary.totalResponses).toBe(3);
    expect(summary.revenueOrdersByCurrency).toEqual([{ currency: "USD", count: 1 }]);
    expect(summary.aovByCurrency).toEqual([{ currency: "USD", minor: 10000 }]);
  });

  it("uses a separate AOV denominator per currency", () => {
    // A shop selling in two currencies: EUR 100 and USD 60. Dividing both by
    // the shared response total would report EUR 50 and USD 30.
    const { summary } = computeStats({
      responses: [response(), response()],
      decidedAmounts: [amount({ minor: 10000, currency: "EUR" }), amount({ minor: 6000, currency: "USD" })],
      ordersInWindow: 2,
    });

    expect(summary.revenueOrdersByCurrency).toEqual([
      { currency: "EUR", count: 1 },
      { currency: "USD", count: 1 },
    ]);
    expect(summary.aovByCurrency).toEqual([
      { currency: "EUR", minor: 10000 },
      { currency: "USD", minor: 6000 },
    ]);
  });

  it("applies the same per-currency denominator to each channel", () => {
    // Two EUR Instagram orders and one USD Google order.
    const { channels } = computeStats({
      responses: [response(), response(), response({ channel: "google" })],
      decidedAmounts: [
        amount({ minor: 10000, currency: "EUR" }),
        amount({ minor: 5000, currency: "EUR" }),
        amount({ minor: 3000, currency: "USD", channel: "google" }),
      ],
      ordersInWindow: 3,
    });

    const instagram = channels.find((c) => c.channel === "instagram");
    // 15000 EUR over 2 orders = 7500, not over 3 responses.
    expect(instagram?.aovByCurrency).toEqual([{ currency: "EUR", minor: 7500 }]);

    const google = channels.find((c) => c.channel === "google");
    expect(google?.aovByCurrency).toEqual([{ currency: "USD", minor: 3000 }]);
  });

  it("omits AOV for a currency whose only responses were excluded from revenue", () => {
    // Both responses reconciled, but neither produced decided revenue. There is
    // no denominator, so there is no AOV rather than a $0.00 average.
    const { summary } = computeStats({
      responses: [response(), response()],
      decidedAmounts: [],
      ordersInWindow: 2,
    });
    expect(summary.aovByCurrency).toEqual([]);
  });

  it("groups per channel", () => {
    const { channels } = computeStats({
      responses: [response(), response({ channel: "google" }), response({ channel: "google" })],
      decidedAmounts: [],
      ordersInWindow: 3,
    });
    expect(channels).toHaveLength(2);
    const google = channels.find((c) => c.channel === "google");
    expect(google?.responses).toBe(2);
  });
});

describe("windowBounds and previousWindowBounds", () => {
  it("returns a window ending now", () => {
    const { start, end } = windowBounds(7, NOW);
    expect(end.getTime()).toBe(NOW.getTime());
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns a previous window of the same length immediately before", () => {
    const current = windowBounds(7, NOW);
    const previous = previousWindowBounds(7, NOW);
    expect(previous.end.getTime()).toBeLessThanOrEqual(current.start.getTime());
  });
});

describe("buildTrend", () => {
  it("emits one point per day including days with no responses", () => {
    const trend = buildTrend({ responses: [], decidedAmounts: [], days: 7, now: NOW });
    expect(trend).toHaveLength(7);
    expect(trend.every((p) => p.responses === 0)).toBe(true);
  });

  it("buckets a response into its UTC day", () => {
    const trend = buildTrend({
      responses: [response({ submittedAt: new Date("2026-10-10T23:59:59.999Z") })],
      decidedAmounts: [],
      days: 7,
      now: NOW,
    });
    expect(trend.find((p) => p.date === "2026-10-10")?.responses).toBe(1);
  });

  it("excludes a response from outside the window", () => {
    const trend = buildTrend({
      responses: [response({ submittedAt: new Date("2020-01-01T00:00:00.000Z") })],
      decidedAmounts: [],
      days: 7,
      now: NOW,
    });
    expect(trend.reduce((sum, p) => sum + p.responses, 0)).toBe(0);
  });

  it("counts every response on a day, not just the first", () => {
    // A busy Saturday is exactly when a merchant most wants to see the spike.
    // Guarding on `!map.has(key)` used to cap the whole chart at 1 per day.
    const day = new Date("2026-10-10T09:00:00.000Z");
    const trend = buildTrend({
      responses: Array.from({ length: 7 }, (_, i) =>
        response({ submittedAt: new Date(day.getTime() + i * 60_000) }),
      ),
      decidedAmounts: [],
      days: 7,
      now: NOW,
    });

    expect(trend.find((p) => p.date === "2026-10-10")?.responses).toBe(7);
    expect(trend.reduce((sum, p) => sum + p.responses, 0)).toBe(7);
  });

  it("keeps per-currency revenue separate within a day", () => {
    const trend = buildTrend({
      responses: [],
      decidedAmounts: [
        amount({ currency: "USD", minor: 1000, submittedAt: new Date("2026-10-10T01:00:00.000Z") }),
        amount({ currency: "EUR", minor: 2000, submittedAt: new Date("2026-10-10T01:00:00.000Z") }),
      ],
      days: 7,
      now: NOW,
    });
    const day = trend.find((p) => p.date === "2026-10-10");
    expect(day?.revenueByCurrency).toHaveLength(2);
  });
it("ends the series on today rather than a day short of it", () => {
    // The window is [now - N days, now]. Walking forward in whole days from
    // `start` produced keys for [start, start + N days), which stops short of
    // today — so every response from the current day was dropped from the chart
    // while the metric tiles above it still counted them.
    const trend = buildTrend({ responses: [], decidedAmounts: [], days: 7, now: NOW });

    expect(trend.at(-1)?.date).toBe("2026-10-15");
  });

  it("counts a response submitted today", () => {
    const trend = buildTrend({
      responses: [response({ submittedAt: new Date("2026-10-15T09:00:00.000Z") })],
      decidedAmounts: [],
      days: 7,
      now: NOW,
    });

    expect(trend.find((p) => p.date === "2026-10-15")?.responses).toBe(1);
    expect(trend.reduce((sum, p) => sum + p.responses, 0)).toBe(1);
  });

  it("covers every response inside the window, so the series totals the tiles", () => {
    // One response per day across the whole window. The chart's own total must
    // equal what the dashboard reports, which is what makes the two reconcilable.
    const inside = Array.from({ length: 7 }, (_, i) =>
      response({ submittedAt: new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000) }),
    );

    const trend = buildTrend({ responses: inside, decidedAmounts: [], days: 7, now: NOW });

    expect(trend.reduce((sum, p) => sum + p.responses, 0)).toBe(7);
  });

  it("anchors on today when now is just past UTC midnight", () => {
    // 00:30 UTC. `start` is then 6 days 23.5 hours back, so advancing in whole
    // days from `start` drifts and can never land on today's date key.
    const justAfterMidnight = new Date("2026-10-15T00:30:00.000Z");
    const trend = buildTrend({
      responses: [response({ submittedAt: new Date("2026-10-15T00:10:00.000Z") })],
      decidedAmounts: [],
      days: 7,
      now: justAfterMidnight,
    });

    expect(trend.at(-1)?.date).toBe("2026-10-15");
    expect(trend.reduce((sum, p) => sum + p.responses, 0)).toBe(1);
  });
});

describe("toUtcDateKey", () => {
  it("uses UTC, so a merchant timezone cannot shift the bucket", () => {
    // 23:30 UTC is already the next day in Tokyo. Bucketing must stay on UTC.
    expect(toUtcDateKey(new Date("2026-10-10T23:30:00.000Z"))).toBe("2026-10-10");
  });
});

describe("evaluateCap", () => {
  it("flags collection at the free cap but never blocks it", () => {
    const status = evaluateCap("free", 50);
    expect(status.atCap).toBe(true);
    expect(status.shouldFlag).toBe(true);
  });

  it("warns at 80% of the cap", () => {
    const status = evaluateCap("free", 40);
    expect(status.atWarning).toBe(true);
    expect(status.atCap).toBe(false);
  });

  it("does not warn below 80%", () => {
    expect(evaluateCap("free", 39).atWarning).toBe(false);
  });

  it("treats warning as ceil(cap * ratio)", () => {
    const status = evaluateCap("free", 0);
    expect(status.warningAt).toBe(Math.ceil(50 * CAP_WARNING_RATIO));
  });

  it("never caps a paid plan", () => {
    const status = evaluateCap("growth", 1_000_000);
    expect(status.cap).toBeNull();
    expect(status.shouldFlag).toBe(false);
    expect(status.atCap).toBe(false);
  });

  it("flags beyond the cap without going negative", () => {
    const status = evaluateCap("free", 80);
    expect(status.exceeded).toBe(true);
    expect(status.used).toBe(80);
  });

  it("treats a negative or NaN usage as zero", () => {
    expect(evaluateCap("free", -5).used).toBe(0);
    expect(evaluateCap("free", Number.NaN).used).toBe(0);
  });

  it("falls back to the free plan for an unknown plan key", () => {
    expect(planFor("enterprise").name).toBe("Free");
  });
});

describe("isPlanKey", () => {
  it("accepts the three real plans and rejects anything else", () => {
    expect(isPlanKey("free")).toBe(true);
    expect(isPlanKey("growth")).toBe(true);
    expect(isPlanKey("scale")).toBe(true);
    expect(isPlanKey("enterprise")).toBe(false);
    expect(isPlanKey(undefined)).toBe(false);
  });
});

describe("currentUtcPeriod", () => {
  it("returns UTC month boundaries", () => {
    const { periodStart, periodEnd } = currentUtcPeriod(NOW);
    expect(periodStart.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("handles a December boundary by rolling the year", () => {
    const { periodEnd } = currentUtcPeriod(new Date("2026-12-20T00:00:00.000Z"));
    expect(periodEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
