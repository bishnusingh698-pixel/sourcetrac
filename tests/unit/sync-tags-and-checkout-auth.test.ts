import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizeTagTemplates, tagsForAnswer } from "@shared/sync-tags";
import { sanitizeTag } from "~/lib/sync.server";
import { classifyRejectedToken, shopDomainFromDest } from "~/lib/checkout-auth.server";

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
