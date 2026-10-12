/**
 * Tag sanitisation and payload-size guards for Phase 7 sync.
 *
 * The channel label that fills `{channel}` in an order/customer tag can be the
 * buyer's free-text "Other" answer. A comma in it would split one tag into
 * several on the order; an unbounded Flow payload would be rejected silently.
 * These are the only defences, so they are pinned here.
 */
import { describe, expect, it } from "vitest";

import { MAX_FLOW_PAYLOAD_BYTES, sanitizeTag, truncateForPayload } from "~/lib/sync.server";

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
