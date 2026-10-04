import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import type { EntryContext } from "react-router";
import { isbot } from "isbot";

import { logger } from "~/lib/logger";
import { addDocumentResponseHeaders } from "~/shopify.server";

/**
 * Streaming SSR entry. Copied from the official React Router template — the
 * 5s timeout plus 1s abort gives React time to flush error boundaries instead
 * of hanging on a slow render.
 */
export const streamTimeout = 5000;

/**
 * Server-side error sink.
 *
 * React Router replaces any thrown `Error` with a sanitized
 * `new Error("Unexpected Server Error")` in production mode before it reaches
 * the browser, which is correct for hiding internals from merchants but means
 * the boundary can only ever show that generic string. Without an export like
 * this the real cause — a Prisma `P2022` for a column missing in production, an
 * Admin API rejection, a bad token — exists only in Render's log stream and is
 * invisible in the UI.
 *
 * This hook receives the error *before* sanitization, so it is the one place
 * the actual failure can be recorded.
 *
 * Only the pathname is logged. An embedded admin request carries `id_token` and
 * `host` in the query string, and a session token must never reach a log sink.
 */
export const handleError = (error: unknown, { request }: { request: Request }) => {
  const { pathname } = new URL(request.url);

  /**
   * A thrown `Response` carries the original failure on a non-public `error`
   * property. `isRouteErrorResponse` narrows to `ErrorResponse`, which omits it,
   * so it is read through a narrow structural type rather than a cast that would
   * hide a genuinely different shape.
   */
  const cause =
    isRouteErrorResponse(error) && "error" in error && error.error instanceof Error
      ? error.error
      : null;

  if (cause) {
    logger.error("request_failed", {
      method: request.method,
      path: pathname,
      status: isRouteErrorResponse(error) ? error.status : undefined,
      status_text: isRouteErrorResponse(error) ? error.statusText : undefined,
      error_message: cause.message,
      error_name: cause.name,
      error_code: (cause as { code?: unknown }).code,
      stack: cause.stack,
    });
    return;
  }

  if (isRouteErrorResponse(error)) {
    // A thrown Response with no cause: an intentional 401/403/404 from a loader.
    logger.warn("request_rejected", {
      method: request.method,
      path: pathname,
      status: error.status,
      status_text: error.statusText,
    });
    return;
  }

  logger.error("request_crashed", {
    method: request.method,
    path: pathname,
    error_message: error instanceof Error ? error.message : String(error),
    error_name: error instanceof Error ? error.name : typeof error,
    error_code:
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  });
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);

  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(new Response(stream, { headers: responseHeaders, status: responseStatusCode }));
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          // SSR-phase failures only. A loader that throws never arrives here:
          // React Router catches it, renders the error boundary, and reports it
          // through `handleError` above, so the document still renders fine.
          // Logging only here is what allowed a production Prisma failure to
          // reach the merchant as an unexplained error card.
          logger.error("ssr_render_failed", {
            error_message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}