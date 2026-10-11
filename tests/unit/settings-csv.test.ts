import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CSV_HEADERS,
  UTF8_BOM,
  csvFilename,
  escapeCsvValue,
  formatTimestamp,
  orderAdminLink,
  resolveExportTimeZone,
  toCsv,
  type CsvRow,
} from "~/lib/csv";
import { ValidationError } from "~/lib/errors";
import { formatDecimalForCurrency } from "~/lib/money";
import {
  MAX_OPTIONS,
  MAX_OPTION_LABEL_LENGTH,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  OTHER_CHANNEL_VALUE,
  parseSurveySettings,
  readIndexedOptions,
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
  it("never gives a new option a channel key an existing option still holds", () => {
    // The default "Google search" is stored as `google`, not `google-search`.
    // A new "Google" option slugs to `google` as well, and both options used
    // to save with that value, merging their answers into one channel.
    const existing = [
      { value: "google", label: "Google search", emoji: null },
      { value: "instagram", label: "Instagram", emoji: null },
    ];
    const labels = ["Google", "Google search", "Instagram", "TikTok", "Podcast", "Email"];
    const result = validateSurveySettings(
      { questionText: "How did you hear about us?", options: options(labels), allowOther: false },
      existing,
    );
    const values = result.options.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    // The existing option keeps its key, so its history still lines up.
    expect(result.options.find((option) => option.label === "Google search")?.value).toBe("google");
    expect(result.options.find((option) => option.label === "Google")?.value).toBe("google-2");
  });

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

  it("keeps Latin slugs exactly as before", () => {
    // Stored channel keys were generated by the old ASCII-only rule. A Latin
    // label must still produce the same key, or a re-save would re-key history.
    expect(slugifyChannel("Friend or family", new Set())).toBe("friend-or-family");
    expect(slugifyChannel("Café & Bar", new Set())).toBe("cafe-bar");
    expect(slugifyChannel("Búsqueda en Google", new Set())).toBe("busqueda-en-google");
  });

  it("keeps letters from non-Latin scripts", () => {
    // These all used to collapse to "channel", so the second one was rejected
    // as a duplicate of the first.
    expect(slugifyChannel("朋友或家人", new Set())).toBe("朋友或家人");
    expect(slugifyChannel("Google 検索", new Set())).toBe("google-検索");
    expect(slugifyChannel("Друзья", new Set())).toBe("друзья");
    expect(slugifyChannel("ブログ", new Set())).not.toBe(slugifyChannel("フログ", new Set()));
  });

  it("still falls back for a label with no letters or digits", () => {
    expect(slugifyChannel("⭐ ⭐", new Set())).toBe("channel");
  });
});

describe("survey in a non-Latin language", () => {
  it("accepts several options written in Chinese", () => {
    const labels = ["搜索引擎", "朋友或家人", "实体店", "小红书", "微信", "抖音"];
    const result = validateSurveySettings({
      questionText: "您是如何了解到我们的？",
      options: labels.map((label) => ({ label, emoji: "" })),
      allowOther: false,
    });
    expect(new Set(result.options.map((o) => o.value)).size).toBe(labels.length);
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
  const row = (overrides: Partial<CsvRow> = {}): CsvRow => ({
    orderName: "#1001",
    orderId: "6123456789012",
    submittedAt: "2026-10-01 05:30:00",
    timeZone: "Asia/Kolkata",
    channel: "Instagram",
    otherAnswer: null,
    orderTotal: "42.50",
    currency: "USD",
    revenueStatus: "counted",
    orderLink: "https://admin.shopify.com/store/demo/orders/6123456789012",
    ...overrides,
  });

  it("starts with a UTF-8 BOM so Excel does not garble non-ASCII labels", () => {
    expect(toCsv([]).startsWith(UTF8_BOM)).toBe(true);
  });

  it("emits the agreed header order", () => {
    const csv = toCsv([]);
    expect(csv.slice(UTF8_BOM.length).split("\r\n")[0]).toBe(CSV_HEADERS.join(","));
  });

  it("writes exactly the documented columns and nothing else", () => {
    expect(CSV_HEADERS).toEqual([
      "order",
      "submitted_at",
      "timezone",
      "channel",
      "other_answer",
      "order_total",
      "currency",
      "revenue_status",
      "order_link",
    ]);
  });

  it("writes the order name, not the 13-digit id spreadsheets show as 6.12346E+12", () => {
    const line = toCsv([row()]).split("\r\n")[1];
    expect(line).toBe(
      "#1001,2026-10-01 05:30:00,Asia/Kolkata,Instagram,,42.50,USD,counted,https://admin.shopify.com/store/demo/orders/6123456789012",
    );
  });

  it("renders an unknown order as blank cells, never 0.00", () => {
    const line = toCsv([row({ orderName: null, orderTotal: null, currency: null, revenueStatus: "awaiting order" })]).split(
      "\r\n",
    )[1];
    expect(line).toBe(
      ",2026-10-01 05:30:00,Asia/Kolkata,Instagram,,,,awaiting order,https://admin.shopify.com/store/demo/orders/6123456789012",
    );
  });

  it("guards a buyer's free-text answer against formula injection", () => {
    const line = toCsv([row({ channel: "Other", otherAnswer: "=HYPERLINK(\"x\")" })]).split("\r\n")[1];
    expect(line).toContain(`,"'=HYPERLINK(""x"")",`);
  });

  it("ends with a newline so the last row is not dropped", () => {
    expect(toCsv([]).endsWith("\r\n")).toBe(true);
  });
});

describe("formatTimestamp", () => {
  const instant = new Date("2026-10-11T20:15:07.311Z");

  it("renders in the shop's zone as a spreadsheet-readable date-time", () => {
    expect(formatTimestamp(instant, "Asia/Kolkata")).toBe("2026-10-12 01:45:07");
    expect(formatTimestamp(instant, "America/New_York")).toBe("2026-10-11 16:15:07");
    expect(formatTimestamp(instant, "UTC")).toBe("2026-10-11 20:15:07");
  });

  it("renders midnight as 00, not 24", () => {
    expect(formatTimestamp(new Date("2026-10-11T00:00:00.000Z"), "UTC")).toBe("2026-10-11 00:00:00");
  });

  it("falls back to UTC for a missing or unknown zone", () => {
    expect(resolveExportTimeZone(null)).toBe("UTC");
    expect(resolveExportTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(formatTimestamp(instant, "Mars/Olympus_Mons")).toBe("2026-10-11 20:15:07");
  });
});

describe("orderAdminLink", () => {
  it("links to the order in the Shopify admin", () => {
    expect(orderAdminLink("demo-store.myshopify.com", "6123456789012")).toBe(
      "https://admin.shopify.com/store/demo-store/orders/6123456789012",
    );
  });
});

describe("csvFilename", () => {
  it("includes the date", () => {
    expect(csvFilename(new Date("2026-10-01T00:00:00.000Z"))).toBe("sourcetrac-responses-2026-10-01.csv");
  });

  it("dates the file in the shop's zone", () => {
    expect(csvFilename(new Date("2026-10-01T20:00:00.000Z"), "Asia/Tokyo")).toBe("sourcetrac-responses-2026-10-02.csv");
  });
});

describe("Settings form limits match the server limits", () => {
  /**
   * The form's `maxLength` attributes had drifted from the constants the server
   * validates against: the question field allowed 140 characters while the server
   * rejects anything over 120, and the emoji field allowed 8 while the server
   * accepts up to 12. `tsc` catches neither, because both are just numbers, and the
   * symptom is a merchant typing something the form happily accepted and the
   * server then refused — with the error surfacing only after a round trip.
   *
   * Asserted against the source because the constants are the single source of
   * truth; a copy of their values here would drift exactly the same way.
   */
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

  it("binds every maxLength to a shared constant", () => {
    const form = read("app/routes/app.settings.tsx");

    for (const constant of ["MAX_QUESTION_LENGTH", "EMOJI_MAX_LENGTH", "MAX_OPTION_LABEL_LENGTH"]) {
      expect(form).toContain(`maxLength={${constant}}`);
    }

    // A bare numeric literal is the drift itself.
    expect(form).not.toMatch(/maxLength=\{\d+\}/);
  });

  it("exports the emoji limit so the form can bind to it", () => {
    expect(read("app/lib/settings.ts")).toMatch(/export const EMOJI_MAX_LENGTH = \d+;/);
  });
});

describe("readIndexedOptions", () => {
  it("pairs each emoji with its own option even when an emoji field is missing", () => {
    const form = new FormData();
    form.append("label.0", "Instagram");
    // emoji.0 absent, as a browser may omit an empty field.
    form.append("label.1", "Google");
    form.append("emoji.1", "🔍");
    form.append("label.10", "TikTok");
    form.append("emoji.10", "🎵");
    form.append("label.2", "Email");

    expect(readIndexedOptions(form)).toEqual([
      { label: "Instagram", emoji: "" },
      { label: "Google", emoji: "🔍" },
      { label: "Email", emoji: "" },
      { label: "TikTok", emoji: "🎵" },
    ]);
  });
});
