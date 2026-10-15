import { db } from "~/db.server";
import { safeEqual } from "~/lib/crypto.server";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

/**
 * GET /readyz — readiness probe. Queries the database, so it must NOT be wired
 * to the uptime pinger or to Render's health check, either of which would keep
 * Neon awake around the clock and exhaust its free compute hours.
 *
 * It requires `x-readyz-secret` (READYZ_SECRET), or `x-retention-secret`
 * while READYZ_SECRET is unset. Open, anyone polling it every
 * four minutes kept Neon from ever suspending (~180 CU-hours a month against
 * 100 free), after which Neon suspends for the rest of the month and the app
 * goes down. Unauthenticated callers get a 404 and the database is not touched.
 */

export const loader = async ({ request }: { request: Request }) => {
  // Its own secret when set, so a monitor need not hold the one that also
  // authorises the data-deleting retention job (sent as `x-readyz-secret`).
  const { READYZ_SECRET, RETENTION_JOB_SECRET } = env();
  const secret = READYZ_SECRET ?? RETENTION_JOB_SECRET;
  const provided = READYZ_SECRET
    ? request.headers.get("x-readyz-secret") ?? ""
    : request.headers.get("x-retention-secret") ?? "";
  if (!secret || !safeEqual(provided, secret)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const startedAt = Date.now();

  try {
    // SELECT 1 is the cheapest statement that proves a working connection.
    await db.$queryRaw`SELECT 1`;
    return new Response(
      JSON.stringify({ status: "ready", db_ms: Date.now() - startedAt }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Neon suspends after 5 minutes idle; the first query after a wake can
    // fail while the branch is being promoted. That is recoverable, so we
    // report 503 and let the orchestrator retry rather than exiting.
    logger.warn("readyz_db_unavailable", {
      db_ms: Date.now() - startedAt,
      error_message: error instanceof Error ? error.message : String(error),
    });

    return new Response(
      JSON.stringify({ status: "not_ready", db_ms: Date.now() - startedAt }),
      { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  }
};

export const action = async () =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "GET" },
  });
