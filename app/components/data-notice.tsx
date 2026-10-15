import type { ReactNode } from "react";

import { SUPPORT_EMAIL } from "@shared/support";

/**
 * What SourceTrac stores, told to the merchant.
 *
 * Layered, the way GDPR transparency guidance suggests: a one-line notice at
 * the foot of every admin page, and the full account on the Privacy page it
 * links to. Every statement here must match `prisma/schema.prisma`; the list
 * below is what the `Response`, `Answer` and `OrderCache` rows actually hold.
 * `tests/unit/data-notice.test.ts` reads the schema and fails if a stored
 * buyer field is added without being named here.
 */

type TFn = (key: string, params?: Record<string, unknown>) => string;

/** The months answers are kept, from `RECORD_RETENTION_DAYS`. */
export type RetentionFacts = { months: number; webhookDays: number };

/** One line at the foot of every page. */
export function DataNotice({ t, months }: { t: TFn; months: number }) {
  return (
    <s-box padding="small" borderRadius="base" background="subdued">
      <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
        <s-icon type="lock" tone="neutral" size="small" />
        <s-text color="subdued" fontSize="small">
          {t("privacy.notice", { months })} <s-link href="/app/privacy">{t("privacy.notice_link")}</s-link>
        </s-text>
      </s-grid>
    </s-box>
  );
}

/**
 * A short inline notice where a setting changes what is collected or where it
 * goes (a typed answer, Shopify actions). Said at the moment it matters.
 */
export function JustInTimeNotice({ children }: { children: ReactNode }) {
  return (
    <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small-200" alignItems="start">
      <s-icon type="lock" tone="neutral" size="small" />
      <s-text color="subdued" fontSize="small">
        {children}
      </s-text>
    </s-grid>
  );
}

/** The stored buyer fields, in the order the Privacy page lists them. */
export const COLLECTED = ["order", "answers", "context"] as const;

/** The full account, for the Privacy page. */
export function DataCollectionDetails({ t, retention }: { t: TFn; retention: RetentionFacts }) {
  return (
    <s-stack gap="base">
      <s-section heading={t("privacy.collect_title")}>
        <s-stack gap="small">
          {COLLECTED.map((key) => (
            <s-grid key={key} gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
              <s-icon type="check-circle" tone="info" size="small" />
              <s-text>{t(`privacy.collect_${key}`)}</s-text>
            </s-grid>
          ))}
          <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
            <s-icon type="check-circle" tone="info" size="small" />
            <s-text>{t("privacy.collect_store")}</s-text>
          </s-grid>
          <s-banner tone="info">{t("privacy.text_warning")}</s-banner>
        </s-stack>
      </s-section>

      <s-section heading={t("privacy.never_title")}>
        <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
          <s-icon type="x-circle" tone="critical" size="small" />
          <s-text>{t("privacy.never_body")}</s-text>
        </s-grid>
      </s-section>

      <s-section heading={t("privacy.why_title")}>
        <s-text>{t("privacy.why_body")}</s-text>
      </s-section>

      <s-section heading={t("privacy.who_title")}>
        <s-text>{t("privacy.who_body")}</s-text>
      </s-section>

      <s-section heading={t("privacy.keep_title")}>
        <s-text>{t("privacy.keep_body", { months: retention.months, days: retention.webhookDays })}</s-text>
      </s-section>

      <s-section heading={t("privacy.rights_title")}>
        <s-text>{t("privacy.rights_body")}</s-text>
      </s-section>

      <s-section heading={t("privacy.contact_title")}>
        <s-text>{t("privacy.contact_body", { email: SUPPORT_EMAIL })}</s-text>
      </s-section>

      <s-section heading={t("privacy.role_title")}>
        <s-stack gap="small">
          <s-text>{t("privacy.role_body")}</s-text>
          <s-box padding="base" border="base" borderRadius="base" background="subdued">
            <s-text>{t("privacy.policy_text", { months: retention.months })}</s-text>
          </s-box>
        </s-stack>
      </s-section>
    </s-stack>
  );
}
