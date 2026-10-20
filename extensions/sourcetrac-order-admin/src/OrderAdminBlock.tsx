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

  // The merchant's admin language, with the English text as a fallback.
  const t = (key: string, fallback: string) => {
    try {
      const value = shopify.i18n.translate(`sourcetrac.${key}`);
      return typeof value === "string" && value.length > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  };

  return (
    <AdminResponseBlock
      apiUrl={API_URL}
      getToken={() => shopify.auth.idToken()}
      context={{ orderId, customerId: null }}
      heading={t("heading", "SourceTrac attribution")}
      loading={t("loading", "Checking for a survey answer…")}
      missing={t("missing_order", "No survey answer recorded for this order.")}
      unavailable={t("unavailable", "Couldn't check for a survey answer right now. Reload the page to try again.")}
      foundPrefix={t("found_prefix", "How they heard about us:")}
    />
  );
}
