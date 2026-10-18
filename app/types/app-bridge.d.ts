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
      /**
       * App Bridge contextual save bar. Its `<button>` children become the
       * Save / Discard actions in the admin's top bar; it is shown and hidden
       * with `shopify.saveBar.show(id)` / `hide(id)`.
       */
      "ui-save-bar": { id: string; children?: React.ReactNode };
    }
  }
}

/**
 * The App Bridge global, narrowed to the one API this app calls. Optional
 * because it only exists inside the Shopify admin, not in local renders.
 */
declare global {
  interface Window {
    shopify?: {
      toast?: { show(message: string, options?: { isError?: boolean }): void };
      /**
       * App Bridge contextual save bar. The editor shows it while there are
       * unsaved changes; `data-save-bar` must never be used on the same page.
       */
      saveBar?: {
        show(id: string): void;
        hide(id: string): void;
      };
      /**
       * The values App Bridge started with. `shop` and `host` are what a
       * full page load needs in its query string to sign back in.
       */
      config?: { shop?: string; host?: string; locale?: string };
    };
  }
}
