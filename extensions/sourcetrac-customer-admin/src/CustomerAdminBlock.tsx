/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import type { Api } from "@shopify/ui-extensions/admin.customer-details.block.render";

import { AdminResponseBlock, numericId } from "../../shared/src/admin-response-block";

/** Must match APP_URL; the extension Web Worker has no env access. */
const API_URL = "https://sourcetrac.onrender.com";

/**
 * admin.customer-details.block.render
 *
 * Shows the merchant what this customer answered. A customer can place several
 * orders, so the backend looks the answer up per customer, not per order.
 */
export default async function extension() {
  render(<CustomerBlock />, document.body);
}

const api = () => (globalThis as unknown as { shopify: Api }).shopify;

function CustomerBlock() {
  const shopify = api();
  const customerId = numericId(shopify.data.selected[0]?.id);

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
      context={{ orderId: null, customerId }}
      heading={t("heading", "SourceTrac attribution")}
      loading={t("loading", "Checking for a survey answer…")}
      missing={t("missing_customer", "No survey answer on this customer's recent orders (about the last 60 days).")}
      unavailable={t("unavailable", "Couldn't check for a survey answer right now. Reload the page to try again.")}
      foundPrefix={t("found_prefix", "How they heard about us:")}
    />
  );
}
