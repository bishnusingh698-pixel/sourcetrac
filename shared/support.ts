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

/**
 * Build the `mailto:` URL for the support button.
 *
 * The subject and body are `encodeURIComponent`-encoded, so a shop domain or a
 * translated string containing `&`, `?` or a space cannot break the link.
 */
export function buildSupportMailto(context: SupportMailtoContext = {}): string {
  const values = {
    shop: context.shop ?? "",
    plan: context.plan ?? "",
    version: context.version ?? "",
    page: context.page ?? "",
  };
  const subject = fill(context.subject ?? DEFAULT_SUBJECT, values);
  const body = fill(context.body ?? DEFAULT_BODY, values);
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
