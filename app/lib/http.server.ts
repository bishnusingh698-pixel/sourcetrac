/**
 * The object React Router's `data()` returns. Its class is not exported at
 * runtime, so it is recognised by shape.
 */
interface DataWithInit {
  type: "DataWithResponseInit";
  data: unknown;
  init: ResponseInit | null;
}

function isDataWithInit(value: unknown): value is DataWithInit {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "DataWithResponseInit" &&
    "data" in value
  );
}

/**
 * Convert a React Router `data()` result (or a plain value) into a `Response`.
 *
 * `data()` is the React Router v7 way to return structured data from a loader,
 * but the `cors()` helper returned by `authenticate.public.checkout` operates
 * on a `Response`, so we bridge the two here rather than duplicating JSON
 * serialisation across the extension routes.
 *
 * The `data()` wrapper must be unwrapped, not serialised. Serialising it sent
 * `{"type":"DataWithResponseInit","data":{"enabled":true,...}}`, so the
 * extension read `enabled` as undefined and hid the survey on every order.
 */
export function toResponse(value: unknown, init: ResponseInit = {}): Response {
  if (value instanceof Response) return value;

  let body = value;
  let merged: ResponseInit = init;
  if (isDataWithInit(value)) {
    body = value.data;
    const inner = value.init ?? {};
    const headers = new Headers(inner.headers);
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    merged = { ...inner, ...init, headers };
  }

  const headers = new Headers(merged.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  // Buyer-facing answers must never be served from an intermediary cache.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");

  return new Response(JSON.stringify(body), { ...merged, headers });
}
/**
 * Read a request body as text, refusing anything over `maxBytes`.
 *
 * `request.json()` buffers the whole body first, so on a public endpoint a
 * single oversized POST could push hundreds of megabytes into a 512 MB
 * instance. The declared length is checked up front, and the stream is counted
 * as it arrives because a chunked body declares none. Returns null when the
 * body is too large.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
