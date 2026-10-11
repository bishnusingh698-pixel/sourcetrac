/**
 * Builds each checkout extension exactly as Shopify CLI 4.8 does and runs the
 * bundle in a simulated checkout page.
 *
 * Nothing else in the suite builds or runs an extension, and that is how the
 * survey shipped rendering nothing at all, in the editor and on live orders:
 * - with `api_version` 2025-10 or later the CLI's entry is
 *   `shopify.extend(target, (...args) => Default(...args))`, which called a
 *   React component full of hooks as a plain function; and
 * - the old React/remote-ui binding's reconciler (react-reconciler 0.29)
 *   crashes on the app's React 19 the moment it renders.
 * Every type check and unit test stayed green throughout.
 *
 * The `shopify` global and `fetch` are stand-ins for the host and the backend;
 * the bundle, Preact and the survey code under test are the real ones.
 */
import { join } from "node:path";

import { build } from "esbuild";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

const SURFACES = [
  {
    name: "thank-you",
    dir: "extensions/sourcetrac-thank-you",
    target: "purchase.thank-you.block.render",
    module: "./src/ThankYouBlock.tsx",
    signal: "orderConfirmation",
    value: { order: { id: "gid://shopify/OrderIdentity/5551234" } },
  },
  {
    name: "order-status",
    dir: "extensions/sourcetrac-order-status",
    target: "customer-account.order-status.block.render",
    module: "./src/OrderStatusBlock.tsx",
    signal: "order",
    value: { id: "gid://shopify/Order/5551234" },
  },
] as const;

/** Same entry and esbuild options the CLI uses for api_version >= 2025-10. */
async function bundle(surface: (typeof SURFACES)[number]): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import Target_0 from '${surface.module}';shopify.extend('${surface.target}', (...args) => Target_0(...args));`,
      resolveDir: join(ROOT, surface.dir),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    target: "es6",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".esnext": "ts", ".js": "jsx" },
    resolveExtensions: [".tsx", ".ts", ".js", ".json", ".esnext", ".mjs", ".ejs"],
    logLevel: "silent",
  });
  const [file] = result.outputFiles;
  if (!file) throw new Error("esbuild produced no output");
  return file.text;
}

type Call = { url: string; method: string; body: string | null; auth: string | undefined };

const saved = { document: globalThis.document, fetch: globalThis.fetch };
afterEach(() => {
  Object.assign(globalThis, saved);
  delete (globalThis as { shopify?: unknown }).shopify;
});

/** Run a bundle against a fake host. Returns helpers to drive and inspect it. */
async function mount(code: string, surface: (typeof SURFACES)[number], editor: boolean) {
  const win = new Window();
  (globalThis as { document: unknown }).document = win.document;

  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      auth: (init.headers as Record<string, string> | undefined)?.Authorization,
    });
    const body = String(url).includes("survey-config")
      ? {
          enabled: true,
          questionText: "Where did you find us?",
          options: [
            { value: "google", label: "Google search", emoji: null },
            { value: "instagram", label: "Instagram", emoji: null },
          ],
          allowOther: false,
          alreadyAnswered: false,
        }
      : { ok: true, counted: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  // As in checkout, the extension hands the host its own Signal class, and the
  // host builds its signals from it so the extension's Preact can subscribe.
  let orderSignal: { value: unknown } | undefined;
  let run: unknown;
  const host: Record<string, unknown> = {
    setSignals(SignalClass: new (value: unknown) => { value: unknown }) {
      orderSignal = new SignalClass(undefined);
      host[surface.signal] = orderSignal;
    },
    extend(_target: string, fn: () => unknown) {
      run = fn();
    },
    sessionToken: { get: async () => "token-123" },
    i18n: { translate: (key: string) => `t:${key}` },
    extension: { editor: editor ? { type: "checkout" } : undefined },
  };
  (globalThis as { shopify?: unknown }).shopify = host;

  new Function(code)();
  await run;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  return {
    calls,
    settle,
    body: () => win.document.body,
    setOrder(value: unknown) {
      if (!orderSignal) throw new Error("the extension never called shopify.setSignals");
      orderSignal.value = value;
    },
    click(element: Element) {
      element.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
    },
  };
}

describe.each(SURFACES)("$name extension bundle", (surface) => {
  it("renders the survey once the order arrives, and submits a tapped answer", async () => {
    const page = await mount(await bundle(surface), surface, false);

    // No order yet: nothing shown, nothing fetched.
    expect(page.calls).toEqual([]);

    page.setOrder(surface.value);
    await page.settle();
    await page.settle();

    expect(page.body().querySelector("s-heading")?.textContent).toBe("Where did you find us?");
    const tiles = page.body().querySelectorAll("s-clickable");
    expect(tiles).toHaveLength(2);
    expect(page.calls[0]).toMatchObject({ method: "GET", auth: "Bearer token-123" });
    expect(page.calls[0]?.url).toContain("/api/survey-config?orderId=");

    page.click(tiles[1] as unknown as Element);
    await page.settle();
    await page.settle();

    const submit = page.calls[1];
    expect(submit).toMatchObject({ method: "POST", auth: "Bearer token-123" });
    expect(JSON.parse(submit?.body ?? "{}")).toMatchObject({ channel: "instagram" });
    expect(page.body().textContent).toContain("t:sourcetrac.thanks");
  });

  it("shows a preview in the checkout editor and never calls the backend", async () => {
    const page = await mount(await bundle(surface), surface, true);

    expect(page.body().querySelector("s-heading")?.textContent).toBe("t:sourcetrac.previewQuestion");
    expect(page.body().querySelectorAll("s-clickable").length).toBeGreaterThan(0);
    expect(page.calls).toEqual([]);
  });

  it("bundles no React", async () => {
    // React 19 is the admin's. Any React in an extension bundle is the
    // binding that crashed, or a second renderer fighting Preact.
    const code = await bundle(surface);
    expect(code).not.toMatch(/node_modules\/react\//);
    expect(code).not.toMatch(/react-reconciler|@remote-ui/);
  });
});
