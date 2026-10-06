import { data } from "react-router";

import { logger } from "~/lib/logger";

/**
 * Plain-language diagnosis of an admin loader/action failure.
 *
 * In production React Router replaces every thrown Error with "Unexpected
 * Server Error" before it reaches the browser, so a merchant (or the app's
 * owner) saw no clue at all, and the only evidence was in the host's logs. A
 * thrown `data()` response is not sanitised, so failures are converted into
 * one carrying a short reference and a fix. No stack, SQL or secret is
 * included: only a category and the Prisma/Node error code.
 */
export type AdminFailure = { reference: string; hint: string };

export function describeAdminFailure(error: unknown): AdminFailure {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : String(error);

  if (code === "P2021" || code === "P2022") {
    return {
      reference: `database_not_migrated (${code})`,
      hint: "The database is missing recent updates. Redeploy the app on Render with the start command `npm run start`, which applies them.",
    };
  }
  if (["P1000", "P1001", "P1002", "P1008", "P1011", "P1017", "P2024"].includes(code) || /ECONNREFUSED|ETIMEDOUT|Can't reach database/i.test(message)) {
    return {
      reference: `database_unreachable${code ? ` (${code})` : ""}`,
      hint: "The app could not reach its database. Check DATABASE_URL on Render and that the Neon project is active, then reload.",
    };
  }
  if (/Invalid environment configuration/.test(message)) {
    return {
      reference: "configuration_invalid",
      hint: message.replace(/^.*?—\s*/, "Fix these settings on Render: "),
    };
  }
  return {
    reference: `${error instanceof Error ? error.name : "unknown"}${code ? ` (${code})` : ""}`,
    hint: "An unexpected error occurred. Reload the page; if it persists, send this reference to support.",
  };
}

function isPassThrough(error: unknown): boolean {
  // Redirects, auth bounces and deliberate `data()` responses must propagate untouched.
  return (
    error instanceof Response ||
    (typeof error === "object" && error !== null && (error as { type?: unknown }).type === "DataWithResponseInit")
  );
}

/** Wrap an admin loader or action so its failures reach the screen diagnosable. */
export function guarded<A extends { request: Request }, R>(fn: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      if (isPassThrough(error)) throw error;
      const failure = describeAdminFailure(error);
      logger.error("admin_request_failed", {
        path: new URL(args.request.url).pathname,
        reference: failure.reference,
        error_message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw data(failure, { status: 500, statusText: "Server Error" });
    }
  };
}
