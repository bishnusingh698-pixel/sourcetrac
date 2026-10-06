import { useState } from "react";
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
  const [open, setOpen] = useState<string | null>(FAQ[0]);

  return (
    <s-stack gap="base">
      <s-section heading={t("help.title")} subheading={t("help.subtitle")} padding="none" />

      <Panel title={t("help.faq_title")}>
        <s-stack gap="small">
          {FAQ.map((id) => {
            const isOpen = open === id;
            const panelId = `faq-answer-${id}`;
            return (
              <s-box key={id} padding="small" border="base" borderRadius="base">
                <s-stack gap="small">
                  {/* Each question is a real button so it is keyboard reachable
                      and announced as expandable. */}
                  <s-button
                    variant="tertiary"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setOpen(isOpen ? null : id)}
                  >
                    {t(`help.q_${id}`)}
                  </s-button>

                  {isOpen ? (
                    <s-text id={panelId}>{t(`help.a_${id}`, { cap: FREE_RESPONSE_CAP })}</s-text>
                  ) : null}
                </s-stack>
              </s-box>
            );
          })}
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
