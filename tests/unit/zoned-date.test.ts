import { describe, expect, it } from "vitest";

import { endOfDayIso, startOfDayIso, storedToDateField } from "@shared/zoned-date";
import { explainTargeting, targetingInstant, type TargetingFacts } from "@shared/survey-config";

const facts = (now: string): TargetingFacts => ({
  orderId: "1",
  orderTotalMinor: null,
  currency: null,
  currencyDigits: 2,
  isFirstOrder: null,
  country: null,
  language: null,
  now: new Date(now),
  responseCount: 0,
});

describe("survey dates are the shop's own calendar days", () => {
  it("starts at local midnight and runs to the end of the end date", () => {
    // India is UTC+05:30 all year.
    expect(startOfDayIso("2026-03-01", "Asia/Kolkata")).toBe("2026-02-28T18:30:00.000Z");
    expect(endOfDayIso("2026-03-31", "Asia/Kolkata")).toBe("2026-03-31T18:30:00.000Z");
    // Los Angeles is UTC-08:00 in winter.
    expect(startOfDayIso("2026-01-10", "America/Los_Angeles")).toBe("2026-01-10T08:00:00.000Z");
    expect(endOfDayIso("2026-01-10", "America/Los_Angeles")).toBe("2026-01-11T08:00:00.000Z");
  });

  it("handles a daylight-saving change inside the range", () => {
    // US clocks go forward on 8 March 2026; the end midnight is PDT (UTC-7).
    expect(startOfDayIso("2026-03-01", "America/New_York")).toBe("2026-03-01T05:00:00.000Z");
    expect(endOfDayIso("2026-03-31", "America/New_York")).toBe("2026-04-01T04:00:00.000Z");
  });

  it("falls back to UTC for a missing or unknown zone", () => {
    expect(startOfDayIso("2026-03-01", null)).toBe("2026-03-01T00:00:00.000Z");
    expect(endOfDayIso("2026-03-01", "Not/AZone")).toBe("2026-03-02T00:00:00.000Z");
  });

  it("rejects dates that are not real calendar days", () => {
    expect(startOfDayIso("2026-02-30", "UTC")).toBeNull();
    expect(endOfDayIso("31/03/2026", "UTC")).toBeNull();
  });

  it("shows the stored instants back as the dates the merchant picked", () => {
    const start = startOfDayIso("2026-03-01", "Asia/Kolkata");
    const end = endOfDayIso("2026-03-31", "Asia/Kolkata");
    expect(storedToDateField(start, "start", "Asia/Kolkata")).toBe("2026-03-01");
    expect(storedToDateField(end, "end", "Asia/Kolkata")).toBe("2026-03-31");
    expect(storedToDateField("2026-05-05", "end", "Asia/Kolkata")).toBe("2026-05-05");
  });

  it("keeps the survey on through the whole end date", () => {
    const endsAt = endOfDayIso("2026-03-31", "Asia/Kolkata")!;
    // 23:59 on 31 March in India is still on.
    expect(explainTargeting({ endsAt }, facts("2026-03-31T18:29:00Z"))).toBeNull();
    expect(explainTargeting({ endsAt }, facts("2026-03-31T18:30:00Z"))).toBe("ended");
  });

  it("reads an older bare end date as the end of that day, not its start", () => {
    expect(targetingInstant("2026-03-31", "end")?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(targetingInstant("2026-03-31", "start")?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(explainTargeting({ endsAt: "2026-03-31" }, facts("2026-03-31T12:00:00Z"))).toBeNull();
  });
});

describe("a start date whose midnight daylight saving skips (L8)", () => {
  it("starts at the first moment of that day, not an hour early on the day before", () => {
    // Chile moves 00:00 to 01:00 on 2026-09-06.
    expect(startOfDayIso("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
    expect(storedToDateField("2026-09-06T04:00:00.000Z", "start", "America/Santiago")).toBe("2026-09-06");
  });
});
