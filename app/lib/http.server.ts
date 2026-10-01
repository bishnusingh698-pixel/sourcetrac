/**
 * Convert a React Router `data()` result into a plain `Response`.
 *
 * `data()` is the React Router v7 way to return structured data from a loader,
 * but the `cors()` helper returned by `authenticate.public.checkout` operates
 * on a `Response`, so we bridge the two here rather than duplicating JSON
 * serialisation across the extension routes.
 */
export function toResponse(value: unknown, init: ResponseInit = {}): Response {
  if (value instanceof Response) return value;

  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  // Buyer-facing answers must never be served from an intermediary cache.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(value), { ...init, headers });
}