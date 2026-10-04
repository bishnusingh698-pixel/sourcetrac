import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the App Bridge wiring.
 *
 * App Bridge is what actually renders this app into the Shopify admin iframe.
 * When it is missing, every loader still succeeds, every health check still
 * passes, and the merchant still sees a blank panel. Nothing at runtime catches
 * it, so the absence is asserted here against the source.
 */
const read = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
    "utf8",
  );

describe("embedded admin app bridge", () => {
  it("wraps the admin shell in AppProvider", () => {
    const shell = read("app/routes/app.tsx");

    expect(shell).toMatch(/import\s+\{\s*AppProvider\s*\}/);
    // The provider must actually render, not merely be imported.
    expect(shell).toMatch(/<AppProvider\s+apiKey=/);
    expect(shell).toContain("</AppProvider>");
  });

  it("passes the public client id to AppProvider", () => {
    const shell = read("app/routes/app.tsx");

    // The loader must hand the key to the component. Hardcoding an empty string
    // in the layout would render an uninitialised App Bridge: the shell appears
    // and then silently does nothing.
    expect(shell).toMatch(/apiKey:\s*process\.env\.SHOPIFY_API_KEY/);
  });

  it("does not load the polaris script twice", () => {
    const root = read("app/root.tsx");

    // AppProvider injects the Polaris web-components script itself. A second
    // hand-written tag in the document head loads the bundle twice.
    expect(root).not.toContain("polaris.js");
  });

  it("never reads process.env in a component that runs in the browser", () => {
    // `process.env` is undefined in the browser, so reading it from a component
    // throws ReferenceError. In an error boundary that is a second failure: it
    // replaces the friendly message with React Router's default blank page, which
    // is the symptom the boundary exists to prevent. Loaders are the only place
    // it is safe, because they run on the server.
    for (const file of ["app/root.tsx", "app/routes/app.tsx"]) {
      // Comments explain the rule and legitimately name process.env, so they are
      // stripped before checking. Otherwise documenting the bug re-fails the guard.
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

      for (const [, component] of source.matchAll(
        /export\s+(?:default\s+)?function\s+(\w+)/g,
      )) {
        const body = source.slice(source.indexOf(`function ${component}`));
        // Only the declaration itself; anything after belongs to the next one.
        const next = body.slice(1).search(/\nexport\s+/);
        const text = next === -1 ? body : body.slice(0, next);

        expect(
          text,
          `${file}: ${component} reads process.env, which does not exist in the browser`,
        ).not.toContain("process.env");
      }
    }
  });

  /**
   * The shell ErrorBoundary must navigate via React Router (useNavigate), not
   * via a bare `href="/app"` on an s-button.
   *
   * In the Shopify embedded admin, `<s-button href="/app">` does a full-page
   * navigation that strips the `?host=` param Shopify requires to authenticate
   * the iframe. Without it, the merchant lands on `/app` without a session
   * token, Shopify redirects to OAuth, and the iframe shows a blank panel —
   * the exact symptom the button exists to fix.
   *
   * `useNavigate` is intercepted by App Bridge and keeps the embedded context
   * (host param, iframe state) intact.
   */
  it("shell ErrorBoundary navigates via useNavigate, not a bare href", () => {
    const shell = read("app/routes/app.tsx");

    // useNavigate must be imported and used in the ErrorBoundary.
    expect(shell).toMatch(/useNavigate/);

    // The ErrorBoundary function body must call navigate("/app"), not link to it.
    const boundaryStart = shell.indexOf("export function ErrorBoundary");
    expect(boundaryStart).toBeGreaterThan(-1);

    // Strip comments before checking so a comment that documents the old bug
    // does not re-fail the guard.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const boundaryBody = stripComments(shell.slice(boundaryStart));

    expect(
      boundaryBody,
      "shell ErrorBoundary must call navigate('/app') to preserve embedded context",
    ).toMatch(/navigate\s*\(\s*["']\/app["']\s*\)/);

    // A bare href="/app" on an s-button in the boundary would strip the host
    // param and break navigation. The navigate() call above is the fix.
    // We allow href on s-button elsewhere (e.g. cap banners), so we only check
    // the boundary body.
    expect(
      boundaryBody,
      "shell ErrorBoundary must not use bare href='/app' on s-button (loses host param)",
    ).not.toMatch(/<s-button[^>]*href=["']\/app["']/);
  });

  /**
   * The root ErrorBoundary must preserve the embedded query params on its
   * dashboard link.
   *
   * The root boundary renders outside AppProvider, so there is no App Bridge
   * router. A bare `href="/app"` strips `?host=&shop=&embedded=` — the merchant
   * clicks the link, Shopify redirects to OAuth, and the iframe shows nothing.
   *
   * The fix is `useLocation` to read the current search string and append it to
   * `/app`, so the embedded context survives the navigation.
   */
  it("root ErrorBoundary preserves search params on the dashboard link", () => {
    const root = read("app/root.tsx");

    // useLocation must be imported.
    expect(root).toMatch(/useLocation/);

    const boundaryStart = root.indexOf("export function ErrorBoundary");
    expect(boundaryStart).toBeGreaterThan(-1);

    // Strip comments before checking so a comment that documents the old bug
    // does not re-fail the guard.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const boundaryBody = stripComments(root.slice(boundaryStart));

    // The boundary must use location.search to build the href.
    expect(
      boundaryBody,
      "root ErrorBoundary must use location.search to preserve embedded params",
    ).toMatch(/location\.search/);

    // A bare href="/app" (without the search params) must not appear.
    expect(
      boundaryBody,
      "root ErrorBoundary must not use bare href='/app' (loses host param)",
    ).not.toMatch(/href=["']\/app["']/);
  });

  /**
   * The production start script must run `prisma migrate deploy` before
   * starting the server.
   *
   * Without it, a freshly provisioned Neon database (or one that has not had
   * the latest migrations applied) will cause every admin request to fail with
   * a Prisma schema error, which surfaces as "Something went wrong" in the
   * embedded admin. The plain `start` script is kept for local dev; `start:prod`
   * is what Render's start command must point to.
   */
  it("start:prod script runs prisma migrate deploy before the server", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    const startProd = pkg.scripts["start:prod"];
    expect(
      startProd,
      "package.json must have a start:prod script",
    ).toBeDefined();

    expect(
      startProd,
      "start:prod must run prisma migrate deploy before starting the server",
    ).toMatch(/prisma migrate deploy/);

    // The server must still start after the migration.
    expect(
      startProd,
      "start:prod must start the server after migrating",
    ).toMatch(/react-router-serve/);
  });

  it("prebundles only packages that are actually installed", () => {
    const vite = read("vite.config.ts");
    const prebundled = [...vite.matchAll(/optimizeDeps\s*:\s*\{[^}]*\}/g)].map(
      (m) => m[0],
    );

    // optimizeDeps.include is a hard require at dev-server start. Naming a
    // package that is not installed fails to resolve and takes the server down.
    for (const block of prebundled) {
      const packages = [...block.matchAll(/["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined)
        .filter((name) => name.startsWith("@") || name.startsWith("."));
      for (const name of packages) {
        expect(
          () => require.resolve(name),
          `${name} is prebundled but not installed`,
        ).not.toThrow();
      }
    }
  });
});
