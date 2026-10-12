/**
 * Runtime scope gating.
 *
 * Phase 7 asks for write scopes, but a merchant who installed before those were
 * added has a session whose `scope` string does not contain them until they
 * re-approve. The danger is the opposite of a crash: a sync code path that
 * *assumes* the scope and fires a GraphQL write anyway, which Shopify rejects,
 * leaving the merchant with a broken app on a store that was working fine.
 *
 * These pin the two failure modes: an empty/absent scope must read as "not
 * granted", and `canSync` must refuse rather than throw.
 */
import { describe, expect, it } from "vitest";

import { canSync, grantedSyncScopes, hasScope, SYNC_SCOPES } from "~/lib/scopes.server";

describe("hasScope", () => {
  it("finds a scope in the comma-separated grant string", () => {
    expect(hasScope("read_orders,write_orders", "write_orders")).toBe(true);
    // Whitespace around entries must not defeat the match.
    expect(hasScope("read_orders, write_orders", "write_orders")).toBe(true);
  });

  it("does not treat a missing grant as 'everything'", () => {
    expect(hasScope(null, "write_orders")).toBe(false);
    expect(hasScope(undefined, "write_orders")).toBe(false);
    expect(hasScope("", "write_orders")).toBe(false);
  });

  it("does not match a substring of a different scope", () => {
    // `read_orders` must not satisfy `write_orders`; a naive `includes` would.
    expect(hasScope("read_orders", "write_orders")).toBe(false);
  });
});

describe("grantedSyncScopes", () => {
  it("returns only the sync scopes actually present, in declaration order", () => {
    expect(grantedSyncScopes("read_orders,read_products")).toEqual(["read_products"]);
    expect(grantedSyncScopes("write_customers,write_orders")).toEqual(["write_orders", "write_customers"]);
  });

  it("returns nothing for a store that has not re-approved", () => {
    expect(grantedSyncScopes("read_orders")).toEqual([]);
    expect(grantedSyncScopes(null)).toEqual([]);
  });
});

describe("canSync", () => {
  it("allows a granted scope", () => {
    for (const scope of SYNC_SCOPES) {
      expect(canSync(`read_orders,${scope}`, scope, "shop-1")).toBe(true);
    }
  });

  it("refuses a missing scope without throwing", () => {
    for (const scope of SYNC_SCOPES) {
      expect(canSync("read_orders", scope, "shop-1")).toBe(false);
      expect(canSync(null, scope, "shop-1")).toBe(false);
    }
  });
});
