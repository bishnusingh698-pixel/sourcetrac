import { describe, expect, it } from "vitest";

import { questionColumnHeader, toSurveyCsv, type SurveyCsvRow } from "~/lib/csv";

function row(overrides: Partial<SurveyCsvRow> = {}): SurveyCsvRow {
  return {
    orderName: "#1001",
    orderId: "1001",
    submittedAt: "2026-10-12 09:00:00",
    timeZone: "UTC",
    placement: "thank_you",
    orderTotal: "42.50",
    currency: "USD",
    revenueStatus: "counted",
    orderLink: "https://admin.shopify.com/store/x/orders/1001",
    answers: { q1: "Instagram" },
    ...overrides,
  };
}

describe("toSurveyCsv", () => {
  it("writes fixed columns then one per question, in order", () => {
    const csv = toSurveyCsv([row()], [{ id: "q1", header: "How did you hear?" }]);
    const [header, line] = csv.replace("\ufeff", "").split("\r\n");
    expect(header).toBe(
      "order,submitted_at,timezone,where,order_total,currency,revenue_status,order_link,How did you hear?",
    );
    expect(line).toContain("#1001,2026-10-12 09:00:00,UTC,thank_you,42.50,USD,counted");
    expect(line).toContain("Instagram");
  });

  it("leaves a blank cell for a question the response did not answer", () => {
    const csv = toSurveyCsv(
      [row({ answers: {} })],
      [
        { id: "q1", header: "Q one" },
        { id: "q2", header: "Q two" },
      ],
    );
    const line = csv.replace("\ufeff", "").split("\r\n")[1] ?? "";
    expect(line.endsWith(",,")).toBe(true);
  });

  it("neutralises formula injection from buyer-authored text", () => {
    const csv = toSurveyCsv([row({ answers: { q1: "=cmd()" } })], [{ id: "q1", header: "Q" }]);
    expect(csv).toContain("'=cmd()");
  });
});

describe("questionColumnHeader", () => {
  it("de-duplicates colliding headers", () => {
    const taken = new Set<string>();
    expect(questionColumnHeader("Same", 0, taken)).toBe("Same");
    expect(questionColumnHeader("Same", 1, taken)).toBe("Same (2)");
    expect(questionColumnHeader("Same", 2, taken)).toBe("Same (3)");
  });

  it("falls back to a positional name for an empty question", () => {
    expect(questionColumnHeader("   ", 0, new Set())).toBe("question_1");
  });
});
