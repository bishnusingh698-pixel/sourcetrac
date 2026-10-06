import { describe, expect, it } from "vitest";

import { describeAdminFailure, guarded } from "~/lib/admin-errors.server";

const args = { request: new Request("https://example.test/app") };

describe("admin failures reach the screen diagnosable", () => {
  it("names a missing migration", () => {
    expect(describeAdminFailure(Object.assign(new Error("column missing"), { code: "P2022" })).reference).toBe(
      "database_not_migrated (P2022)",
    );
  });

  it("names an unreachable database", () => {
    expect(describeAdminFailure(Object.assign(new Error("x"), { code: "P1001" })).reference).toMatch(
      /^database_unreachable/,
    );
  });

  it("converts an Error into a data() response that production does not sanitise", async () => {
    const thrown = await guarded(async () => {
      throw Object.assign(new Error("boom"), { code: "P2021" });
    })(args).catch((e: unknown) => e);
    expect((thrown as { type?: string }).type).toBe("DataWithResponseInit");
    expect((thrown as { data: { reference: string } }).data.reference).toBe("database_not_migrated (P2021)");
  });

  it("lets auth redirects through untouched", async () => {
    const redirect = new Response(null, { status: 302 });
    await expect(guarded(async () => { throw redirect; })(args)).rejects.toBe(redirect);
  });
});
