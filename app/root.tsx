import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  useRouteLoaderData,
  type LinksFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { resolveRequestLanguage } from "~/lib/i18n/resolve.server";
import stylesheet from "~/styles/app.css?url";

/**
 * Document shell for the embedded admin.
 *
 * Polaris Web Components ship from a Shopify CDN script tag rather than npm —
 * the `@shopify/polaris` React package is deprecated. TypeScript types come from
 * the separate `@shopify/polaris-types` package. The script itself is injected by
 * `AppProvider` in the admin shell, not here: this route also renders the public
 * privacy policy, which has no App Bridge and must not pull it in.
 */

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
];

/**
 * Root loader.
 *
 * Resolves the document language only, and deliberately does NOT authenticate:
 * this loader also runs for `/healthz`, the public privacy policy, and the error
 * boundary, none of which have a session. An unresolvable locale falls back to
 * English.
 *
 * The embedded admin routes sit behind `authenticate.admin` and resolve their
 * own language with the merchant's saved preference included; this value is what
 * the document element needs before any of that runs.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const language = resolveRequestLanguage({
    requested: url.searchParams.get("lng"),
    shopifyLocale: url.searchParams.get("locale"),
    acceptLanguage: request.headers.get("accept-language"),
  });

  return { language };
}

/**
 * The subset of the admin shell's loader data that the document needs.
 *
 * Declared structurally rather than imported from `./routes/app`: `root.tsx` is
 * the parent of every route, so importing the shell back into it would create a
 * module cycle. Only `language` is read, and it is a plain string, so a narrow
 * structural type is safe and keeps this file independent of the shell.
 */
type ShellLoaderData = { language: string } | undefined;

/**
 * `<html lang>`.
 *
 * Server-rendered from the root loader so the very first paint is already in the
 * right language. Resolving this on the client instead would render English, then
 * swap — a visible flash, an SSR hydration mismatch, and a wrong `lang`
 * attribute, which makes a screen reader announce German text in an English voice
 * and disables the correct pronunciation rules.
 *
 * The shell's value wins over the root's whenever it is present. The root loader
 * deliberately does not read the database — it also runs for `/healthz`, the
 * privacy page and the error boundary, none of which have a session — so it can
 * only ever see `?lng=`, `?locale` and `Accept-Language`. For a merchant who has
 * chosen a language in the app, that is stale: the shell loader reads the saved
 * preference and would render German text inside `lang="en"`.
 *
 * Reading it back out of the shell's loader data costs nothing. That query has
 * already run by the time the document renders, so there is no extra round trip
 * and no extra DB load on `/healthz`, which still resolves to English.
 */
export function DocumentLanguage() {
  const root = useRouteLoaderData<typeof loader>("root");
  const shell = useRouteLoaderData<ShellLoaderData>("routes/app");

  return <html lang={shell?.language ?? root?.language ?? "en"} />;
}

export default function App() {
  return (
    <>
      <DocumentLanguage />
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </>
  );
}

/**
 * Root error boundary.
 *
 * Without this React Router renders its own default boundary, which in an
 * embedded iframe is a blank page with no visible cause — the merchant sees the
 * admin shell's title bar and an empty body. This renders an explanation and a
 * reload path instead.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error";

  return (
    <>
      <DocumentLanguage />
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <Meta />
        <Links />
      </head>
      <body>
        <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: "1rem" }}>{message}</p>
          <a href="/app">Back to dashboard</a>
        </main>
        <Scripts />
      </body>
    </>
  );
}
