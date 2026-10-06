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
