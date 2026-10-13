/**
 * Tag sanitisation and payload-size guards for Phase 7 sync.
 *
 * The channel label that fills `{channel}` in an order/customer tag can be the
 * buyer's free-text "Other" answer. A comma in it would split one tag into
 * several on the order; an unbounded Flow payload would be rejected silently.
 * These are the only defences, so they are pinned here.
 */
import { describe, expect, it } from "vitest";

import { hasSyncWork, MAX_FLOW_PAYLOAD_BYTES, parseSyncOptions, requiredScopes, sanitizeTag, truncateForPayload } from "~/lib/sync.server";

describe("sanitizeTag", () => {
  it("strips commas so a buyer cannot create extra tags", () => {
    expect(sanitizeTag("survey:instagram,evil,more")).toBe("survey:instagramevilmore");
  });

  it("strips control characters, quotes and backslashes", () => {
    expect(sanitizeTag('a"b\\c\u0000d\ne')).toBe("abcde");
  });

  it("lower-cases and trims", () => {
    expect(sanitizeTag("  Instagram  ")).toBe("instagram");
  });

  it("caps the length at 40 characters", () => {
    expect(sanitizeTag("x".repeat(100)).length).toBe(40);
  });

  it("keeps non-Latin letters", () => {
    expect(sanitizeTag("友人の紹介")).toBe("友人の紹介");
  });

  it("keeps an ordinary prefixed tag intact", () => {
    expect(sanitizeTag("survey-hdyhau:google-search")).toBe("survey-hdyhau:google-search");
  });
});

describe("parseSyncOptions", () => {
  it("keeps preset ids verbatim and clamps them", () => {
    const parsed = parseSyncOptions({ presets: ["delivery_status_order_tag", 7, "nps_customer_tag"] });
    expect(parsed.presets).toEqual(["delivery_status_order_tag", "nps_customer_tag"]);
  });
});

describe("hasSyncWork + requiredScopes with T13 presets", () => {
  it("reports work for a preset-only survey", () => {
    // Without this a template survey whose only write-back is a preset would
    // enqueue nothing, and the tag would never appear.
    expect(hasSyncWork({ presets: ["delivery_status_order_tag"] })).toBe(true);
  });

  it("asks for write_orders for an order-tag preset", () => {
    expect(requiredScopes({ presets: ["delivery_status_order_tag"] })).toEqual(["write_orders"]);
  });

  it("asks for write_customers for a customer preset", () => {
    expect(requiredScopes({ presets: ["nps_customer_tag"] })).toEqual(["write_customers"]);
  });

  it("asks for write_customers for a customer metafield preset", () => {
    // The field belongs to the customer, so the order scope must not be enough.
    expect(requiredScopes({ presets: ["profile_customer_metafield"] })).toEqual(["write_customers"]);
  });

  it("ignores an unknown preset id", () => {
    expect(hasSyncWork({ presets: ["no_such_preset"] })).toBe(false);
    expect(requiredScopes({ presets: ["no_such_preset"] })).toEqual([]);
  });
});

describe("truncateForPayload", () => {
  it("leaves a short string unchanged", () => {
    expect(truncateForPayload("hello", 100)).toBe("hello");
  });

  it("truncates and marks a long string, staying within the byte budget", () => {
    const long = "a".repeat(200);
    const out = truncateForPayload(long, 50);
    expect(out.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50);
  });

  it("respects multibyte characters", () => {
    // Each emoji is 4 bytes; a naïve length slice would overflow the byte cap.
    const long = "🎉".repeat(100);
    const out = truncateForPayload(long, 50);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50);
  });
});

describe("flow payload budget", () => {
  it("keeps the ceiling below Shopify's 50,000-byte limit", () => {
    expect(MAX_FLOW_PAYLOAD_BYTES).toBeLessThan(50_000);
  });
});
