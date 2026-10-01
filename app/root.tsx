import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

/**
 * Document shell for the embedded admin.
 *
 * Polaris Web Components ship from a Shopify CDN script tag rather than npm —
 * the `@shopify/polaris` React package is deprecated. TypeScript types come from
 * the separate `@shopify/polaris-types` package. The script must load in the
 * document head: it scans the DOM and upgrades `s-*` elements in place, so
 * deferring it to the end of the body causes a visible flash of unstyled admin
 * chrome on first paint.
 */
export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}