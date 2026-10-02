import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { orderIdSchema } from "~/lib/settings";

/**
 * Both extension routes validate orderId with this one schema, and
 * `orders/create` writes `String(order.id)` from the REST Admin API payload.
 * Attribution works only if those two agree.
 *
 * The ui-extensions type for `orderConfirmation.value.order.id` and
 * `order.value.id` is only `id: string`, so the type system cannot prove the
 * shapes match — this test is the pin. It imports the production schema rather
 * than repeating the regex, so it fails if a route stops using it.
 *
 * Consequence of divergence: answers are written with an order id no
 * `OrderCache` row can match, so they never reconcile, stay "Pending", and
 * their revenue never reaches the dashboard.
 */
describe("orderId format invariant", () => {
  // Shape written by upsertOrderCache: String(order.id) from orders/create.
  const WEBHOOK_ORDER_ID = "8209829109466";

  it("accepts an order id in the shape the webhook stores", () => {
    expect(orderIdSchema.safeParse(WEBHOOK_ORDER_ID).success).toBe(true);
  });

  it("rejects a GID instead of silently storing an unmatchable id", () => {
    // If this ever passes, the extension and the webhook are writing different
    // id shapes and every answer will be permanently unreconciled.
    expect(orderIdSchema.safeParse(`gid://shopify/Order/${WEBHOOK_ORDER_ID}`).success).toBe(false);
  });

  it("rejects an empty id, which is what an unloaded extension sends", () => {
    // The `if (!orderId)` guard in use-survey.ts is the primary defence; this
    // is the backstop that keeps "" out of the database if it is ever bypassed.
    expect(orderIdSchema.safeParse("").success).toBe(false);
  });

  it("rejects an id long enough to be abusive", () => {
    expect(orderIdSchema.safeParse("9".repeat(65)).success).toBe(false);
  });

  it("is the validator both extension routes actually use", () => {
    // Drift guard: the assertions above only mean something if the routes
    // import this schema instead of keeping their own copy of the regex.
    for (const route of ["api.responses", "api.survey-config"]) {
      const source = readFileSync(
        join(import.meta.dirname, "..", "..", "app", "routes", `${route}.tsx`),
        "utf8",
      );
      expect(source, `${route} must validate with orderIdSchema`).toMatch(/orderIdSchema/);
      expect(source, `${route} must not inline its own orderId regex`).not.toMatch(
        /orderId:[^\n]*\d\+|orderId:\s*z\./,
      );
    }
  });
});
