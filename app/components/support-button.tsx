import { useMemo } from "react";

import {
  buildSupportMailto,
  SUPPORT_BODY_KEY,
  SUPPORT_EMAIL,
  SUPPORT_SUBJECT_KEY,
} from "@shared/support";
import { useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import type { TFunction } from "~/lib/i18n";

/**
 * Email support button.
 *
 * Opens the merchant's own email app through the operating system's `mailto:`
 * handler. The link is a plain anchor with `target="_top"`, which is the App
 * Bridge-supported way to open an external URL from inside the admin iframe
 * (see `https://shopify.dev/docs/api/app-bridge-library/apis/navigation`): the
 * `_top` target leaves the iframe and lets the browser hand off to the mail
 * client. If no mail client is configured, the browser simply does nothing.
 *
 * The address is not secret and is shown wherever it helps. It is never shown
 * to buyers: this component is only used in the embedded admin.
 */

/** Page name for the mail body. A plain key string, resolved by the caller. */
export type SupportPageKey = string;

function buildLink(
  t: TFunction,
  { shop, plan, version, page }: { shop?: string; plan?: string; version?: string; page?: string },
): string {
  return buildSupportMailto({
    shop,
    plan,
    version,
    page,
    subject: t(SUPPORT_SUBJECT_KEY),
    body: t(SUPPORT_BODY_KEY),
  });
}

/**
 * Icon-only button for page headers and error screens.
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
}: {
  shop?: string;
  plan?: string;
  version?: string;
  page?: string;
  variant?: "secondary" | "auto";
  /** Set to `"secondary-actions"` when placed in a page title bar. */
  slot?: Lowercase<string>;
}) {
  const { t } = useAdminI18n();
  const href = useMemo(
    () => buildLink(t, { shop, plan, version, page }),
    [t, shop, plan, version, page],
  );
  const label = t("support.button_label");

  return (
    <s-button
      href={href}
      target="_top"
      variant={variant}
      icon="email"
      accessibilityLabel={label}
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
  const href = useMemo(
    () => buildLink(t, { shop, plan, version, page }),
    [t, shop, plan, version, page],
  );

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
        <s-button href={href} target="_top" variant="secondary" icon="email">
          {t("support.button_label")}
        </s-button>
      </s-stack>
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-text>{SUPPORT_EMAIL}</s-text>
        <s-button type="button" variant="tertiary" icon="clipboard" onClick={copy}>
          {t("support.copy")}
        </s-button>
      </s-stack>
      {note ? (
        <s-text color="subdued" fontSize="small">
          {note}
        </s-text>
      ) : null}
    </s-stack>
  );
}
