import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards server-side error visibility.
 *
 * React Router replaces every thrown `Error` with
 * `new Error("Unexpected Server Error")` in production mode before the response
 * is sent. That is correct — it stops internals leaking to merchants — but it
 * also means an error boundary can only ever show that generic string.
 *
 * A production Prisma failure therefore reaches the merchant as an unexplained
 * error card while the only trace is a bare `console.error` in Render's log
 * stream, if one exists at all. The `onError` callback inside
 * `renderToPipeableStream` is NOT that trace: it fires for SSR-phase failures,
 * and a loader that throws never reaches it, because React Router catches the
 * throw, renders the boundary, and still produces a successful document.
 *
 * `handleError` is the only export that receives the unsanitized error, so its
 * presence and its secret-safety are asserted here rather than left to review.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("server error surfacing", () => {
  it("exports handleError, which receives the pre-sanitization error", () => {
    const entry = read("app/entry.server.tsx");

    expect(
      entry,
      "entry.server must export handleError; without it a loader error is only ever a generic string in the UI",
    ).toMatch(/export\s+const\s+handleError/);
  });

  it("records the underlying message rather than the sanitized placeholder", () => {
    const entry = stripComments(read("app/entry.server.tsx"));

    // The diagnostic value is the cause: message, name, code and stack.
    expect(entry).toMatch(/error_message/);
    expect(entry).toMatch(/error_code/);
    expect(entry).toMatch(/\bstack\b/);
  });

  it("never logs the query string, which carries id_token and host", () => {
    const entry = stripComments(read("app/entry.server.tsx"));

    // An embedded admin request puts `id_token` (a bearer credential) and `host`
    // in the query string, so a full URL in a log line is a credential leak.
    //
    // Scoped to what actually reaches the logger rather than the whole function:
    // `new URL(request.url)` is required to obtain the pathname and is not a leak
    // on its own. What must never appear is the URL or the parsed query being
    // passed *into* a log field.
    const logged = [...entry.matchAll(/logger\.(?:error|warn|info|debug)\(([\s\S]*?)\n\s*\}\);/g)]
      .map((match) => match[0])
      .join("\n");

    expect(logged.length, "expected handleError to emit log records").toBeGreaterThan(0);
    expect(logged).not.toMatch(/request\.url/);
    expect(logged).not.toMatch(/searchParams/);
    expect(logged).not.toMatch(/id_token/);
    // And the safe alternative must actually be used.
    expect(logged).toMatch(/pathname/);
  });

  it("distinguishes a thrown Response from a thrown Error", () => {
    const entry = stripComments(read("app/entry.server.tsx"));

    // A loader that throws `new Response(null, {status: 401})` is intentional
    // control flow and must not be logged as a crash, while a Prisma failure
    // must not be silently downgraded to a warning.
    expect(entry).toMatch(/isRouteErrorResponse/);
    expect(entry).toMatch(/logger\.error/);
    expect(entry).toMatch(/logger\.warn/);
  });
});