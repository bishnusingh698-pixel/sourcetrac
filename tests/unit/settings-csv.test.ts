import { describe, expect, it } from "vitest";

import { escapeCsvValue, toCsv, CSV_HEADERS, csvFilename } from "~/lib/csv";
import { ValidationError } from "~/lib/errors";
import { formatDecimalForCurrency } from "~/lib/money";
import {
  MAX_OPTIONS,
  MAX_OPTION_LABEL_LENGTH,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  OTHER_CHANNEL_VALUE,
  parseSurveySettings,
  slugifyChannel,
  validateSurveySettings,
} from "~/lib/settings";

/**
 * Settings validation is the merchant-facing contract: it must refuse bad input
 * with a message that tells them how to fix it, and must never silently
 * collapse two channels into one.
 */

const options = (labels: string[]) => labels.map((label) => ({ label, emoji: "" }));

const six = ["Instagram", "Google", "TikTok", "Friend", "Podcast", "Email"];

describe("validateSurveySettings", () => {
  it("accepts exactly the minimum option count", () => {
    const result = validateSurveySettings(
      { questionText: "How did you hear about us?", options: options(six), allowOther: false },
      [],
    );
    expect(result.options).toHaveLength(MIN_OPTIONS);
  });

  it("rejects fewer than the minimum and says how many to add", () => {
    try {
      validateSurveySettings(
        { questionText: "How?", options: options(six.slice(0, 3)), allowOther: false },
        [],
      );
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).hint).toContain(`Add ${MIN_OPTIONS - 3} more`);
      expect((error as ValidationError).fields.field).toBe("options");
    }
  });

  it("rejects more than the maximum and says how many to remove", () => {
    const tooMany = Array.from({ length: MAX_OPTIONS + 2 }, (_, i) => `Channel ${i}`);
    try {
      validateSurveySettings({ questionText: "How?", options: options(tooMany), allowOther: false }, []);
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect((error as ValidationError).fields.field).toBe("options");
      expect((error as ValidationError).hint).toContain("Remove 2");
    }
  });

  it("rejects two options that slug to the same channel", () => {
    try {
      validateSurveySettings(
        { questionText: "How?", options: options(["Instagram", "instagram", "Google", "Friend", "Podcast", "Email"]), allowOther: false },
        [],
      );
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields.field).toMatch(/^options\.\d+\.label$/);
    }
  });

  it("rejects an empty question", () => {
    try {
      validateSurveySettings({ questionText: "   ", options: options(six), allowOther: false }, []);
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect((error as ValidationError).fields.field).toBe("questionText");
    }
  });

  it("rejects a question longer than the limit", () => {
    try {
      validateSurveySettings({
        questionText: "x".repeat(MAX_QUESTION_LENGTH + 1),
        options: options(six),
        allowOther: false,
      }, []);
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect((error as ValidationError).fields.field).toBe("questionText");
    }
  });

  it("rejects an over-long option label", () => {
    const long = [...six];
    long[2] = "y".repeat(MAX_OPTION_LABEL_LENGTH + 1);
    try {
      validateSurveySettings({ questionText: "How?", options: options(long), allowOther: false }, []);
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect((error as ValidationError).fields.field).toBe("options.2.label");
    }
  });

  it("rejects a non-array options payload", () => {
    expect(() =>
      validateSurveySettings({ questionText: "How?", options: "nope", allowOther: false }, []),
    ).toThrow(ValidationError);
  });

  it("preserves an existing channel value when the label is unchanged", () => {
    // Renaming must not orphan historical responses.
    const existing = validateSurveySettings(
      { questionText: "How?", options: options(six), allowOther: false },
      [],
    ).options;

    const unchanged = validateSurveySettings(
      { questionText: "How did you find us?", options: options(six), allowOther: false },
      existing,
    ).options;

    expect(unchanged.map((o) => o.value)).toEqual(existing.map((o) => o.value));
  });

  it("only treats allowOther as true for a real boolean", () => {
    const result = validateSurveySettings(
      { questionText: "How?", options: options(six), allowOther: "true" },
      [],
    );
    expect(result.allowOther).toBe(false);
  });
});

describe("formatDecimalForCurrency", () => {
  // The export path must not re-round to a fixed two places. These three cases
  // are exactly what a hardcoded `toFixed(2)` got wrong.
  it("keeps three decimal places for KWD", () => {
    expect(formatDecimalForCurrency("1.234", "KWD")).toBe("1.234");
    expect(formatDecimalForCurrency("0.001", "KWD")).toBe("0.001");
  });

  it("keeps zero decimal places for JPY", () => {
    expect(formatDecimalForCurrency("5000", "JPY")).toBe("5000");
    expect(formatDecimalForCurrency(5000, "JPY")).toBe("5000");
  });

  it("keeps two decimal places for USD", () => {
    expect(formatDecimalForCurrency("19.9", "USD")).toBe("19.90");
    expect(formatDecimalForCurrency("19.99", "USD")).toBe("19.99");
  });

  it("accepts a Prisma Decimal-like object", () => {
    // Prisma returns Decimal, not string. Only the numeric string form matters.
    const decimal = { toString: () => "1.234" };
    expect(formatDecimalForCurrency(decimal, "KWD")).toBe("1.234");
  });

  it("returns null for null, undefined and empty input", () => {
    expect(formatDecimalForCurrency(null, "USD")).toBeNull();
    expect(formatDecimalForCurrency(undefined, "USD")).toBeNull();
    expect(formatDecimalForCurrency("", "USD")).toBeNull();
  });

  it("returns null rather than a bogus number for unparseable input", () => {
    expect(formatDecimalForCurrency("not-a-number", "USD")).toBeNull();
  });
});

describe("slugifyChannel", () => {
  it("produces a stable lowercase slug", () => {
    expect(slugifyChannel("Instagram", new Set())).toBe("instagram");
  });

  it("suffixes a collision", () => {
    expect(slugifyChannel("Instagram", new Set(["instagram"]))).toBe("instagram-2");
  });
});

describe("parseSurveySettings", () => {
  it("falls back safely on corrupt stored JSON rather than throwing", () => {
    const fallback = {
      questionText: "How?",
      options: options(six).map((o, i) => ({ value: `v${i}`, label: o.label, emoji: "" })),
      allowOther: false,
    };
    const result = parseSurveySettings("{not json", fallback);
    expect(result.options.length).toBeGreaterThan(0);
  });

  it("falls back on null", () => {
    const fallback = {
      questionText: "How?",
      options: options(six).map((o, i) => ({ value: `v${i}`, label: o.label, emoji: "" })),
      allowOther: false,
    };
    expect(parseSurveySettings(null, fallback)).toEqual(fallback);
  });
});

describe("OTHER_CHANNEL_VALUE", () => {
  it("is a reserved value a merchant label cannot collide with", () => {
    expect(slugifyChannel(OTHER_CHANNEL_VALUE, new Set())).toBe(OTHER_CHANNEL_VALUE);
  });
});

describe("escapeCsvValue", () => {
  it("quotes a value containing a comma", () => {
    expect(escapeCsvValue("a,b")).toBe('"a,b"');
  });

  it("doubles embedded quotes per RFC 4180", () => {
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  it("neutralises a formula even behind leading whitespace", () => {
    expect(escapeCsvValue("  =1+1")).toBe("  '=1+1");
  });

  it.each(["=cmd()", "+1", "-1", "@SUM(A1)"])("neutralises %s", (payload) => {
    expect(escapeCsvValue(payload).startsWith("'")).toBe(true);
  });

  it("renders null and undefined as an empty cell, not the text 'null'", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("emits the agreed header order", () => {
    const csv = toCsv([]);
    expect(csv.split("\r\n")[0]).toBe(CSV_HEADERS.join(","));
  });

  it("writes exactly the requested columns and nothing else", () => {
    expect(CSV_HEADERS).toEqual(["order_id", "submitted_at", "channel", "order_total", "currency"]);
  });

  it("renders an unknown order total as a blank cell", () => {
    const csv = toCsv([
      { orderId: "1", submittedAt: new Date("2026-10-01T00:00:00.000Z"), channel: "web", orderTotal: null, currency: null },
    ]);
    expect(csv).toContain("1,2026-10-01T00:00:00.000Z,web,,");
  });

  it("ends with a newline so the last row is not dropped", () => {
    expect(toCsv([]).endsWith("\r\n")).toBe(true);
  });
});

describe("csvFilename", () => {
  it("includes the date", () => {
    expect(csvFilename(new Date("2026-10-01T00:00:00.000Z"))).toBe("sourcetrac-responses-2026-10-01.csv");
  });
});
