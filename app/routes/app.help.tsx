import { type MetaFunction } from "react-router";

import { Panel } from "~/components/admin-ui";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { FREE_RESPONSE_CAP } from "~/lib/plans";

/**
 * Help: FAQ plus a support contact.
 *
 * Deliberately static. The questions that matter here are the ones a merchant
 * asks when setting up or when the survey is not appearing, so the answers lead
 * with the checkout editor and plan checks rather than billing.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "help.title");

const SUPPORT_EMAIL = "support@sourcetrac.app";

/**
 * Question/answer key pairs, in display order. Creating the survey comes first
 * because it is the question a new merchant cannot answer from the UI alone:
 * the block is placed in Shopify's checkout editor, not inside this app.
 */
const FAQ = [
  "create",
  "not_showing",
  "both_pages",
  "missing_revenue",
  "refunds",
  "limit",
  "privacy",
  "change",
  "cancel",
] as const;

export default function Help() {
  const { t } = useAdminI18n();

  return (
    <s-stack gap="base">
      <s-section heading={t("help.title")} subheading={t("help.subtitle")} padding="none" />

      <Panel title={t("help.faq_title")}>
        <s-stack gap="small">
          {/* Native disclosure elements rather than `s-button` toggles. A
              button label is a single line, so on a phone a long question was
              cut off mid-sentence; a summary wraps. It is also keyboard and
              screen-reader accessible with no script, and several answers can
              be open at once. */}
          {FAQ.map((id, index) => (
            <s-box key={id} padding="small" border="base" borderRadius="base">
              <details className="st-faq" open={index === 0}>
                <summary>
                  <s-text type="strong">{t(`help.q_${id}`)}</s-text>
                </summary>
                <s-box paddingBlockStart="small">
                  <s-text>{t(`help.a_${id}`, { cap: FREE_RESPONSE_CAP })}</s-text>
                </s-box>
              </details>
            </s-box>
          ))}
        </s-stack>
      </Panel>

      <Panel title={t("help.contact_title")}>
        <s-stack gap="small">
          <s-text>{t("help.contact_body")}</s-text>
          <div>
            <s-link href={`mailto:${SUPPORT_EMAIL}`}>
              {t("help.contact_cta")}: {SUPPORT_EMAIL}
            </s-link>
          </div>
          <s-text color="subdued" fontSize="small">
            {t("help.contact_tip")}
          </s-text>
        </s-stack>
      </Panel>
    </s-stack>
  );
}
