import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

// The CLI passes HOST; Vite's own config uses it too. Normalising to
// SHOPIFY_APP_URL avoids breaking the dev server when they differ.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

let hmrConfig: UserConfig["server"] extends infer S
  ? S extends { hmr?: infer H }
    ? H
    : undefined
  : undefined;

if (host === "localhost") {
  hmrConfig = { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 };
} else {
  hmrConfig = {
    protocol: "wss",
    host,
    port: Number.parseInt(process.env.FRONTEND_PORT ?? "8002", 10),
    clientPort: 443,
  };
}

/**
 * The browser bundle gets English only; the server keeps all ten languages.
 * The merchant's language reaches the browser in the shell loader's data. See
 * `app/lib/i18n/bundled-locales.ts`.
 */
const browserLocales: Plugin = {
  name: "sourcetrac:browser-locales",
  enforce: "pre",
  resolveId(source, importer, options) {
    if (options?.ssr || source !== "./bundled-locales" || !importer?.includes("/app/lib/i18n/")) return null;
    return fileURLToPath(new URL("./app/lib/i18n/bundled-locales.browser.ts", import.meta.url));
  },
};

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number.parseInt(process.env.PORT || "3000", 10),
    hmr: hmrConfig,
    fs: { allow: ["app", "shared", "node_modules"] },
  },
  plugins: [browserLocales, reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
}) satisfies UserConfig;
