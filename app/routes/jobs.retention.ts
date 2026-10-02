import { safeEqual } from "~/lib/crypto.server";
import { env } from "~/lib/env";
import { logger } from "~/lib/logger";
import { runRetentionPurge } from "~/lib/retention.server";

/**
 * POST /jobs/retention — run one retention pass.
 *
 * There is no in-process scheduler: Render's free tier has no cron, and a
 * `setInterval` would drift and die with the container. An external scheduler
 * (cron-job.org, or Render Cron on a paid tier) POSTs here once a day.
 *
 * The route deletes customer data, so it is not reachable without a secret even
 * though the delete is itself bounded by the retention window. Compared in
 * constant time, and the failure mode is deliberately indistinguishable from a
 * wrong path so the endpoint cannot be probed for existence.
 */

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const action = async ({ request }: { request: Request }) => {
  const { RETENTION_JOB_SECRET } = env();

  if (!RETENTION_JOB_SECRET) {
    // Never run unauthenticated. Failing closed is the whole point: an open
    // delete endpoint is worse than no endpoint at all.
    logger.error("retention_job_unconfigured", {});
    return new Response(JSON.stringify({ error: "not_configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const provided = request.headers.get("x-retention-secret") ?? "";
  if (!safeEqual(provided, RETENTION_JOB_SECRET)) {
    logger.warn("retention_job_unauthorized", {});
    return unauthorized();
  }

  try {
    const report = await runRetentionPurge();
    return new Response(JSON.stringify({ status: "ok", ...report }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Surfaced rather than swallowed: a silent failure here means retention
    // silently stops, which is the exact failure this job exists to prevent.
    logger.error("retention_job_failed", {
      error_message: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ status: "error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
};

export const loader = async () =>
  new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST", "Cache-Control": "no-store" },
  });