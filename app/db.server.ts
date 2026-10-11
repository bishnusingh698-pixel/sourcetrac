import { PrismaClient } from "@prisma/client";

import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

/**
 * Single Prisma client per process.
 *
 * Kept on globalThis so Vite's dev-server module reloads don't open a new pool
 * on every edit — Neon enforces a connection limit and exhausting it locks the
 * merchant out of their own dashboard.
 */

declare global {
  var __sourcetracPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: env().NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  client.$connect().catch((error: unknown) => {
    // Non-fatal: Neon suspends after 5 minutes idle and wakes on connect.
    // Requests retry at the route level (docs/03 FLOW 12).
    logger.warn("db_connect_deferred", {
      error_message: error instanceof Error ? error.message : String(error),
    });
  });

  return client;
}

export const db: PrismaClient = globalThis.__sourcetracPrisma ?? createClient();

if (env().NODE_ENV !== "production") {
  globalThis.__sourcetracPrisma = db;
}

/**
 * Classify a Prisma error as retryable.
 *
 * Retryable: cannot reach server, connection closed or timed out, pool
 * timeout, deadlock, write conflict.
 * Not retryable: unique violation (that is our idempotency success path) and
 * foreign-key violation (a bug, not a transient fault).
 */
export function isRetryableDbError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return false;

  // P1017 ("server has closed the connection") is what a pooled connection
  // throws after Neon suspends an idle compute and drops it, and P1002 is a
  // timeout while it wakes. Both succeed on the next attempt; leaving them out
  // failed the first request after every idle period.
  return ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034", "P2028"].includes(code);
}

export function dbErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
