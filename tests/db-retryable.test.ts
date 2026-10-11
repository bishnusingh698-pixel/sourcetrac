/**
 * Which Prisma errors are retried. Lives with the DB tests because importing
 * `~/db.server` needs the full environment.
 */
import { describe, expect, it } from "vitest";

import { isRetryableDbError } from "~/db.server";

describe("isRetryableDbError", () => {
  it.each(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"])("retries %s", (code) => {
    // P1017 is what a pooled connection throws after Neon suspends an idle
    // compute and closes it; not retrying it failed the first request after
    // every idle period.
    expect(isRetryableDbError({ code })).toBe(true);
  });

  it.each(["P2002", "P2003", "P2025"])("does not retry %s", (code) => {
    // A unique violation is the idempotency success path; the others are bugs.
    expect(isRetryableDbError({ code })).toBe(false);
  });
});
