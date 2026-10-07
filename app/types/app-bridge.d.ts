import "react";

/**
 * `<s-app-nav>` is an App Bridge element, not a Polaris one, so
 * `@shopify/polaris-types` does not declare it. App Bridge reads its `s-link`
 * children and renders them in the Shopify admin sidebar.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": { children?: React.ReactNode };
    }
  }
}

/**
 * The App Bridge global, narrowed to the one API this app calls. Optional
 * because it only exists inside the Shopify admin, not in local renders.
 */
declare global {
  interface Window {
    shopify?: { toast?: { show(message: string, options?: { isError?: boolean }): void } };
  }
}
