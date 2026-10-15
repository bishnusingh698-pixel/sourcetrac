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
    value: { order: { id: "gid://shopify/OrderIdentity/5551234" }, isFirstOrder: true },
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
async function mount(
  code: string,
  surface: (typeof SURFACES)[number],
  editor: boolean,
  surveyOverride: Record<string, unknown> = {},
) {
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
    const body = String(url).includes("/api/survey?")
      ? {
          enabled: true,
          orderId: "5551234",
          placement: "thank_you",
          alreadyAnswered: false,
          survey: {
            id: "survey-1",
            version: 1,
            priority: 0,
            placements: ["thank_you", "order_status"],
            layout: "all",
            title: "Quick question",
            intro: "Your answer helps us improve.",
            buttonLabel: "Submit",
            thankYouText: "Thanks for your feedback!",
            channelReportQuestionId: "q1",
            targeting: {},
            translations: {
              de: {
                title: "Kurze Frage",
                questions: { q1: { text: "Wie hast du uns gefunden?" } },
              },
            },
            questions: [
              {
                id: "q1",
                type: "single_choice",
                text: "Where did you find us?",
                textMultiline: false,
                required: true,
                randomizeOptions: false,
                allowOther: false,
                options: [
                  { id: "google", label: "Google search", isOther: false, translations: { de: "Google Suche" } },
                  { id: "instagram", label: "Instagram", isOther: false },
                ],
              },
            ],
            ...surveyOverride,
          },
        }
      : { ok: true, counted: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  // As in checkout, the extension hands the host its own Signal class, and the
  // host builds its signals from it so the extension's Preact can subscribe.
  let orderSignal: { value: unknown } | undefined;
  let paymentSignal: { value: unknown } | undefined;
  let run: unknown;
  const host: Record<string, unknown> = {
    setSignals(SignalClass: new (value: unknown) => { value: unknown }) {
      orderSignal = new SignalClass(undefined);
      host[surface.signal] = orderSignal;
      // Only the thank-you surface exposes payment options; the customer-account
      // one does not, so it must still render without them.
      if (surface.name === "thank-you") {
        paymentSignal = new SignalClass([]);
        host.selectedPaymentOptions = paymentSignal;
      }
    },
    extend(_target: string, fn: () => unknown) {
      run = fn();
    },
    sessionToken: { get: async () => "token-123" },
    i18n: { translate: (key: string) => `t:${key}` },
    // The buyer's localization context. Both surfaces expose the order's
    // country here; the extension forwards it for country targeting.
    localization: {
      language: { value: { isoCode: "en" } },
      country: { value: { isoCode: "US" } },
    },
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
    setPaymentTypes(types: string[]) {
      if (!paymentSignal) throw new Error("this surface does not expose payment options");
      paymentSignal.value = types.map((type, i) => ({ handle: `h${i}`, type }));
    },
    setLocale(code: string) {
      (host.localization as { language: { value: { isoCode: string } } }).language.value = { isoCode: code };
    },
    click(element: Element) {
      element.dispatchEvent(new win.Event("click", { bubbles: true }) as unknown as Event);
    },
    type(element: Element, value: string) {
      (element as unknown as { value: string }).value = value;
      element.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
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

    // The survey title is the heading; the question text is the first strong text.
    expect(page.body().querySelector("s-heading")?.textContent).toBe("Quick question");
    expect(page.body().textContent).toContain("Where did you find us?");
    const tiles = page.body().querySelectorAll("s-clickable");
    expect(tiles).toHaveLength(2);
    expect(page.calls[0]).toMatchObject({ method: "GET", auth: "Bearer token-123" });
    expect(page.calls[0]?.url).toContain("/api/survey?");

    page.click(tiles[1] as unknown as Element);
    await page.settle();
    await page.settle();

    // Single-question surveys auto-submit on the tap.
    const submit = page.calls[1];
    expect(submit).toMatchObject({ method: "POST", auth: "Bearer token-123" });
    expect(JSON.parse(submit?.body ?? "{}")).toMatchObject({
      surveyId: "survey-1",
      answers: [{ questionId: "q1", optionIds: ["instagram"] }],
    });
    expect(page.body().textContent).toContain("Thanks for your feedback!");
  });

  it("does not submit a single text question on the first keystroke (H1)", async () => {
    const page = await mount(await bundle(surface), surface, false, {
      questions: [
        { id: "q1", type: "text", text: "Anything else?", textMultiline: false, required: true, randomizeOptions: false, allowOther: false, options: [] },
      ],
    });
    page.setOrder(surface.value);
    await page.settle();
    await page.settle();

    const field = page.body().querySelector("s-text-field");
    expect(field).not.toBeNull();
    page.type(field as unknown as Element, "a");
    await page.settle();
    page.type(field as unknown as Element, "a friend");
    await page.settle();
    expect(page.calls.filter((call) => call.method === "POST")).toHaveLength(0);

    page.click(page.body().querySelector("s-button") as unknown as Element);
    await page.settle();
    await page.settle();
    const posts = page.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "{}")).toMatchObject({
      surveyVersion: 1,
      answers: [{ questionId: "q1", textValue: "a friend" }],
    });
  });

  it("shows a preview in the checkout editor and never calls the backend", async () => {
    const page = await mount(await bundle(surface), surface, true);

    expect(page.body().querySelector("s-heading")?.textContent).toBe("t:sourcetrac.previewTitle");
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

  it("sends the selected payment types on the config fetch (T7)", async () => {
    // Regression guard: the config fetch used to omit `paymentTypes` entirely,
    // so a survey targeting manual payment methods saw an empty list on every
    // order and hid itself. Only the thank-you surface exposes the selection.
    if (surface.name !== "thank-you") return;

    const page = await mount(await bundle(surface), surface, false);
    page.setPaymentTypes(["manualPayment", "creditCard"]);
    page.setOrder(surface.value);
    await page.settle();
    await page.settle();

    const config = page.calls.find((call) => call.url.includes("/api/survey?"));
    expect(config).toBeDefined();
    expect(new URL(config!.url, "https://example.test").searchParams.get("paymentTypes")).toBe(
      "manualPayment,creditCard",
    );
  });

  it("sends the first-order flag and country on the config fetch", async () => {
    // Regression guard: the route passed `isFirstOrder: null` and `country:
    // null`, so first/returning and country targeting never matched and the
    // survey silently never appeared. The facts now travel as query params.
    const page = await mount(await bundle(surface), surface, false);
    page.setOrder(surface.value);
    await page.settle();
    await page.settle();

    const config = page.calls.find((call) => call.url.includes("/api/survey?"));
    expect(config).toBeDefined();
    const params = new URL(config!.url, "https://example.test").searchParams;
    expect(params.get("country")).toBe("US");
    if (surface.name === "thank-you") {
      // The order-confirmation signal carries `isFirstOrder`; the
      // customer-account order object does not, so only the thank-you surface
      // can supply it.
      expect(params.get("isFirstOrder")).toBe("1");
    } else {
      expect(params.get("isFirstOrder")).toBeNull();
    }
  });

  it("sends the buyer's language and renders the translated survey", async () => {
    // Regression guard: the config fetch hardcoded `locale = null`, so language
    // targeting never matched and the merchant's per-language text was never
    // applied — every buyer saw the default language.
    const page = await mount(await bundle(surface), surface, false);
    page.setLocale("de");
    page.setOrder(surface.value);
    await page.settle();
    await page.settle();

    const config = page.calls.find((call) => call.url.includes("/api/survey?"));
    expect(config).toBeDefined();
    expect(new URL(config!.url, "https://example.test").searchParams.get("locale")).toBe("de");

    // The fake config carries a German pack; with the locale applied the German
    // title and question text are what render.
    expect(page.body().querySelector("s-heading")?.textContent).toBe("Kurze Frage");
    expect(page.body().textContent).toContain("Wie hast du uns gefunden?");
    expect(page.body().textContent).toContain("Google Suche");
  });
});

/**
 * The admin block extensions render in the *admin* host, which is a different
 * runtime from the checkout host: there is no order signal, and the merchant
 * gets their answer by POSTing the id from `shopify.data.selected` to our
 * backend with an ID token. Nothing in the checkout suite exercises that path,
 * and `check:extensions` only reads the TOML.
 */
const ADMIN_SURFACES = [
  {
    name: "order-details",
    dir: "extensions/sourcetrac-order-admin",
    target: "admin.order-details.block.render",
    module: "./src/OrderAdminBlock.tsx",
    selectedId: "gid://shopify/Order/7777",
  },
  {
    name: "customer-details",
    dir: "extensions/sourcetrac-customer-admin",
    target: "admin.customer-details.block.render",
    module: "./src/CustomerAdminBlock.tsx",
    selectedId: "gid://shopify/Customer/8888",
  },
] as const;

async function bundleAdmin(surface: (typeof ADMIN_SURFACES)[number]): Promise<string> {
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

async function mountAdmin(code: string, surface: (typeof ADMIN_SURFACES)[number], answerFound: boolean) {
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
    return new Response(
      JSON.stringify(
        answerFound
          ? { found: true, channel: "instagram", channelLabel: "Instagram", surveyName: "How did you hear?", submittedAt: "2026-10-11T00:00:00.000Z" }
          : { found: false, channel: null, channelLabel: null, surveyName: null, submittedAt: null },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  let run: unknown;
  const host: Record<string, unknown> = {
    extend(_target: string, fn: () => unknown) {
      run = fn();
    },
    data: { selected: [{ id: surface.selectedId }] },
    auth: { idToken: async () => "id-token-xyz" },
    i18n: { translate: (key: string) => `t:${key}` },
  };
  (globalThis as { shopify?: unknown }).shopify = host;

  new Function(code)();
  await run;
  // Two ticks: the first lets Preact flush the initial render, the second lets
  // the awaited idToken + fetch + setState chain settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { calls, body: () => win.document.body };
}

describe.each(ADMIN_SURFACES)("$name admin extension bundle", (surface) => {
  it("posts the selected id with the ID token and shows the recorded answer", async () => {
    const page = await mountAdmin(await bundleAdmin(surface), surface, true);

    expect(page.body().querySelector("s-admin-block")?.getAttribute("heading")).toBe("SourceTrac attribution");
    expect(page.body().textContent).toContain("Instagram");

    const [call] = page.calls;
    expect(call).toMatchObject({ method: "POST", auth: "Bearer id-token-xyz" });
    expect(call?.url).toContain("/api/admin-survey-context");
    const body = JSON.parse(call?.body ?? "{}") as { orderId: string | null; customerId: string | null };
    // The GID is stripped to the numeric tail; the other field stays null.
    expect(body.orderId ?? body.customerId).toBe(surface.selectedId.match(/(\d+)$/)![1]);
  });

  it("shows the no-answer copy rather than erroring when there is nothing recorded", async () => {
    const page = await mountAdmin(await bundleAdmin(surface), surface, false);

    expect(page.body().textContent).toMatch(/No survey answer recorded/);
  });

  it("bundles no React", async () => {
    const code = await bundleAdmin(surface);
    expect(code).not.toMatch(/node_modules\/react\//);
    expect(code).not.toMatch(/react-reconciler|@remote-ui/);
  });
});

