import { logger } from "~/lib/logger";

/**
 * GET /healthz — liveness probe.
 *
 * MUST NOT touch the database. An uptime pinger hitting this endpoint should
 * never be able to wake Neon, because waking Neon burns compute hours for a
 * request that needs no data. A real readiness check lives at /readyz.
 */

/**
 * Captured at module init so a pinger can tell a freshly-booted cold start
 * apart from one that has been serving for a while.
 */
const BOOTED_AT = new Date().toISOString();

export const loader = async () => {
  // Logging is one stdout write, not a network round trip. At pinger cadence
  // this is negligible; set LOG_LEVEL=error to silence it entirely.
  logger.debug("healthz", { probe: true });

  return new Response(
    JSON.stringify({
      status: "ok",
      service: "sourcetrac",
      booted_at: BOOTED_AT,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Never cache: a cached 200 would hide a dead process from the pinger.
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
};

/** Any other method is a client error, not a liveness signal. */
export const action = async () =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "GET" },
  });
