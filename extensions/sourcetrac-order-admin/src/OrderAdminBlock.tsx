/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import type { Api } from "@shopify/ui-extensions/admin.order-details.block.render";

import { AdminResponseBlock, numericId } from "../../shared/src/admin-response-block";

/** Must match APP_URL; the extension Web Worker has no env access. */
const API_URL = "https://sourcetrac.onrender.com";

/**
 * admin.order-details.block.render
 *
 * Shows the merchant what this order's buyer answered. The API is the `shopify`
 * global; with api_version 2026-07 the CLI calls this default export as a plain
 * function, so it renders rather than being a component itself.
 */
export default async function extension() {
  render(<OrderBlock />, document.body);
}

const api = () => (globalThis as unknown as { shopify: Api }).shopify;

function OrderBlock() {
  const shopify = api();
  const orderId = numericId(shopify.data.selected[0]?.id);

  return (
    <AdminResponseBlock
      apiUrl={API_URL}
      getToken={() => shopify.auth.idToken()}
      context={{ orderId, customerId: null }}
      heading="SourceTrac attribution"
      loading="Checking for a survey answer…"
      missing="No survey answer recorded for this order."
      foundPrefix="How they heard about us:"
    />
  );
}
