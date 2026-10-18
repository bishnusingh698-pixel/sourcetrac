import crypto from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { normalizeTagTemplates, tagsForAnswer } from "@shared/sync-tags";
import { sanitizeTag } from "~/lib/sync.server";
import { classifyRejectedToken, shopDomainFromDest } from "~/lib/checkout-auth.server";
import { clearServeLog, recentServes, recordServe } from "~/lib/serve-log.server";

describe("the tag a merchant's template produces", () => {
  it("prefixes a bare tag and fills {channel}, exactly as the sync writes it", () => {
    const templates = normalizeTagTemplates(["vip", "source:{channel}", "{channel}"]) ?? [];
    expect(templates).toEqual(["sourcetrac:vip", "source:{channel}", "sourcetrac:{channel}"]);
    expect(tagsForAnswer(templates, "Instagram Ads")).toEqual(["sourcetrac:vip", "source:instagram ads", "sourcetrac:instagram ads"]);
  });

  it("never lets a buyer's text split or reshape a tag", () => {
    expect(tagsForAnswer(["source:{channel}"], "a,b:c")).toEqual(["source:ab-c"]);
    // A channel template with no answer writes nothing, not "source:".
    expect(tagsForAnswer(["source:{channel}"], "")).toEqual([]);
  });

  it("is the same sanitiser the sync uses", () => {
    expect(sanitizeTag("Hello, World!")).toBe("hello world");
  });
});

describe("a refused checkout token's log reason", () => {
  const secret = "s3cret";
  const sign = (payload: object, key = secret) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${h}.${p}.${crypto.createHmac("sha256", key).update(`${h}.${p}`).digest("base64url")}`;
  };

  it("separates a wrong app secret from an expired token", () => {
    const now = 1_000_000;
    expect(classifyRejectedToken(null, secret).reason).toBe("no_token");
    expect(classifyRejectedToken("Bearer nope", secret).reason).toBe("malformed");
    expect(classifyRejectedToken(`Bearer ${sign({ dest: "a.myshopify.com" }, "other")}`, secret)).toEqual({
      reason: "bad_signature",
      dest: "a.myshopify.com",
    });
    expect(classifyRejectedToken(`Bearer ${sign({ exp: now - 60 })}`, secret, now).reason).toBe("expired");
  });

  it("reduces a URL in dest to the shop domain", () => {
    expect(shopDomainFromDest("https://Store.myshopify.com/admin")).toBe("store.myshopify.com");
    expect(shopDomainFromDest("store.myshopify.com")).toBe("store.myshopify.com");
  });
});

describe("recent checkouts log", () => {
  beforeEach(() => clearServeLog());
  const entry = (orderId: string, reason: "shown" | "sample" = "shown") => ({
    placement: "thank_you" as const,
    orderId,
    surveyId: "s1",
    reason,
    pinned: false,
    country: null,
    isFirstOrder: null,
  });

  it("keeps the newest first, one line per reload, bounded", () => {
    recordServe("shop", entry("1"));
    recordServe("shop", entry("1"));
    expect(recentServes("shop")).toHaveLength(1);
    for (let i = 0; i < 30; i += 1) recordServe("shop", entry(String(100 + i)));
    const list = recentServes("shop");
    expect(list).toHaveLength(20);
    expect(list[0]?.orderId).toBe("129");
    expect(recentServes("another")).toEqual([]);
  });
});
