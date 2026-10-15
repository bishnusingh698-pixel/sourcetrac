import { useMemo } from "react";

import {
  buildSupportGmailUrl,
  buildSupportMailto,
  SUPPORT_BODY_KEY,
  SUPPORT_EMAIL,
  SUPPORT_SUBJECT_KEY,
} from "@shared/support";
import { useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import type { TFunction } from "~/lib/i18n";

/**
 * Email support buttons.
 *
 * The button used to be a Polaris button whose `href` was a `mailto:`. Inside the
 * admin iframe that did nothing for most merchants: App Bridge treats an `href`
 * on a Polaris button as in-app navigation, and even where the browser did get
 * the `mailto:` it only works with a desktop mail app registered, which webmail
 * users do not have. So the button now opens Gmail's compose window in a new
 * tab with `window.open` from a click handler, which the admin iframe allows
 * (it is sandboxed with `allow-popups`). The Help page also offers the plain
 * `mailto:` link for other mail apps, and the address itself to copy.
 *
 * The address is not secret and is shown wherever it helps. It is never shown
 * to buyers: this component is only used in the embedded admin.
 */

/** Page name for the mail body. A plain key string, resolved by the caller. */
export type SupportPageKey = string;

type SupportContext = { shop?: string; plan?: string; version?: string; page?: string };

function useSupportLinks(t: TFunction, { shop, plan, version, page }: SupportContext) {
  return useMemo(() => {
    const context = {
      shop,
      plan,
      version,
      page,
      subject: t(SUPPORT_SUBJECT_KEY),
      body: t(SUPPORT_BODY_KEY),
    };
    return { gmail: buildSupportGmailUrl(context), mailto: buildSupportMailto(context) };
  }, [t, shop, plan, version, page]);
}

/**
 * Open a URL outside the admin iframe.
 *
 * A popup blocker can still refuse (it returns null). Falling back to the
 * `mailto:` link through a real anchor click hands the message to the
 * operating system's mail app instead of doing nothing.
 */
function openExternal(url: string, fallback?: string): void {
  // Not the `noopener` feature string: with it `window.open` returns null even
  // when the tab opened, which would fire the fallback as well.
  const opened = window.open(url, "_blank");
  if (opened) {
    opened.opener = null;
    return;
  }
  if (!fallback) return;
  const link = document.createElement("a");
  link.href = fallback;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * The "Email support" button for page headers and error screens. Opens a
 * prefilled Gmail message to support in a new tab.
 *
 * `accessibilityLabel` gives it a name for screen readers and the hover/focus
 * tooltip; without it an icon button is announced as "button".
 */
export function SupportIconButton({
  shop,
  plan,
  version,
  page,
  variant = "secondary",
  slot,
}: SupportContext & {
  variant?: "secondary" | "auto";
  /** Set to `"secondary-actions"` when placed in a page title bar. */
  slot?: Lowercase<string>;
}) {
  const { t } = useAdminI18n();
  const links = useSupportLinks(t, { shop, plan, version, page });
  const label = t("support.button_label");

  return (
    <s-button
      type="button"
      onClick={() => openExternal(links.gmail, links.mailto)}
      variant={variant}
      icon="email"
      accessibilityLabel={t("support.button_aria")}
      {...(slot ? { slot } : {})}
    >
      {label}
    </s-button>
  );
}

/**
 * Icon + label button, and the address shown as text, for the Help page.
 *
 * The address is shown because some merchants have no mail app configured; the
 * text can be copied into a webmail client instead. `intro` and `note` let the
 * Help page use its own wording (and keep its own translation keys in use) while
 * this component still owns the address, the link and the copy button.
 */
export function SupportContactPanel({
  shop,
  plan,
  version,
  page,
  intro,
  note,
}: {
  shop?: string;
  plan?: string;
  version?: string;
  page?: string;
  intro?: string;
  note?: string;
}) {
  const { t } = useAdminI18n();
  const links = useSupportLinks(t, { shop, plan, version, page });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      window.shopify?.toast?.show(t("support.copied"));
    } catch {
      // Clipboard can be blocked (permissions, insecure context). The address is
      // already on screen as selectable text, so failing quietly is enough.
      window.shopify?.toast?.show(t("support.copy_failed"), { isError: true });
    }
  };

  return (
    <s-stack gap="base">
      <s-text>{intro ?? t("support.body")}</s-text>
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button type="button" variant="primary" icon="email" onClick={() => openExternal(links.gmail, links.mailto)}>
          {t("support.open_gmail")}
        </s-button>
        <s-button type="button" variant="secondary" onClick={() => openExternal(links.mailto)}>
          {t("support.open_mail_app")}
        </s-button>
      </s-stack>
      {/* The address as text, for Outlook.com, Yahoo or any other webmail. A
          plain element so a long address wraps instead of overflowing. */}
      <s-box padding="small" border="base" borderRadius="base" background="subdued">
        <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
          <div className="st-wrap">
            <s-text type="address">{SUPPORT_EMAIL}</s-text>
          </div>
          <s-button type="button" variant="tertiary" icon="clipboard" onClick={copy}>
            {t("support.copy")}
          </s-button>
        </s-grid>
      </s-box>
      {note ? (
        <s-text color="subdued" fontSize="small">
          {note}
        </s-text>
      ) : null}
    </s-stack>
  );
}
