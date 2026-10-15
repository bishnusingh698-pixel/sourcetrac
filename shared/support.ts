/**
 * Support contact, in one place.
 *
 * `SUPPORT_EMAIL` is the only email address this app is allowed to contain. Every
 * screen that shows or links to support imports it from here, so a future change
 * is a one-line edit and a typo cannot reach the UI. The address is not secret:
 * it is shown on the Help page and in the privacy policy on purpose.
 *
 * `buildSupportMailto` is the single builder for the `mailto:` link. It is kept
 * free of i18n on purpose: this module is shared, and the translated subject and
 * body come from the caller's `t()` so the same link works in all ten languages.
 */

export const SUPPORT_EMAIL = "sourcetracsupport@gmail.com";

/**
 * Fallback app version for the support mail body. The shell loader prefers
 * `process.env.npm_package_version` (accurate under `npm start`) and uses this
 * only when that is unavailable.
 */
export const APP_VERSION = "1.0.0";

/** i18n keys the caller resolves before calling `buildSupportMailto`. */
export const SUPPORT_SUBJECT_KEY = "support.mail_subject";
export const SUPPORT_BODY_KEY = "support.mail_body";

export type SupportMailtoContext = {
  /** Shop domain, e.g. `example.myshopify.com`. */
  shop?: string | null;
  /** Plan label the merchant sees, e.g. "Free" or "Growth". */
  plan?: string | null;
  /** App version, e.g. "1.0.0". */
  version?: string | null;
  /** Where the merchant was when they asked for help. */
  page?: string | null;
  /**
   * Translated subject. Omitted by the unit test and any caller without a
   * translator, in which case the English default is used.
   */
  subject?: string;
  /** Translated body template. See `subject`. */
  body?: string;
};

const DEFAULT_SUBJECT = "Support request: SourceTrac";

/**
 * English fallback body. The blank line before the prompt is deliberate: it
 * leaves the merchant room to type without deleting a label first.
 */
const DEFAULT_BODY = [
  "Shop: {shop}",
  "Plan: {plan}",
  "App version: {version}",
  "Page: {page}",
  "",
  "",
  "Describe your question or problem here:",
].join("\n");

/** Replace the four known placeholders. Unknown braces are left untouched. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(shop|plan|version|page)\}/g, (_, key: string) => values[key] ?? "");
}

function filled(context: SupportMailtoContext): { subject: string; body: string } {
  const values = {
    shop: context.shop ?? "",
    plan: context.plan ?? "",
    version: context.version ?? "",
    page: context.page ?? "",
  };
  return {
    subject: fill(context.subject ?? DEFAULT_SUBJECT, values),
    body: fill(context.body ?? DEFAULT_BODY, values),
  };
}

/**
 * Gmail's web compose window, prefilled with the address, subject and body.
 *
 * This is what the support button opens. A `mailto:` link depends on the
 * merchant having a desktop mail app registered, and from inside the admin
 * iframe it was routed through App Bridge's in-app navigation instead of the
 * browser, so in practice the button did nothing. A normal https URL opened in
 * a new tab works in every browser; a merchant without Gmail can still use the
 * `mailto:` link or copy the address from the Help page.
 */
export function buildSupportGmailUrl(context: SupportMailtoContext = {}): string {
  const { subject, body } = filled(context);
  const params = new URLSearchParams({ view: "cm", fs: "1", to: SUPPORT_EMAIL, su: subject, body });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/**
 * Build the `mailto:` URL for the support button.
 *
 * The subject and body are `encodeURIComponent`-encoded, so a shop domain or a
 * translated string containing `&`, `?` or a space cannot break the link.
 */
export function buildSupportMailto(context: SupportMailtoContext = {}): string {
  const { subject, body } = filled(context);
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
