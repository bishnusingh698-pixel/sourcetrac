import { describe, expect, it } from "vitest";

import { safeInternalPath } from "../../app/lib/http.server";

/** `/auth?redirect=` must never send a merchant off the app. */
describe("safeInternalPath", () => {
  it("keeps an internal path", () => {
    expect(safeInternalPath("/app/settings?x=1")).toBe("/app/settings?x=1");
  });

  it.each([
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "evil.com",
  ])("rejects %j", (value) => {
    // Browsers read a backslash as `/` and strip tabs and newlines, so each of these
    // can become a protocol-relative URL to another host.
    expect(safeInternalPath(value)).toBe("/app");
  });
});
