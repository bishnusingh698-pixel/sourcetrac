import { db } from "~/db.server";
import { logger } from "~/lib/logger";

/**
 * GET /readyz — readiness probe. Does query the database, so it must NOT be
 * wired to the external uptime pinger. Point Render's own health check here if
 * you want it to gate traffic on the database.
 */

export const loader = async () => {
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
