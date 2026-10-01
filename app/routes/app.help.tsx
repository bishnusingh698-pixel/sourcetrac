import { useState } from "react";
import { type MetaFunction } from "react-router";

import { Panel } from "~/components/admin-ui";

/**
 * Help: FAQ plus a support contact.
 *
 * Deliberately static. The questions that matter here are the ones a merchant
 * asks when the survey is not appearing, so the answers lead with the plan and
 * editor checks rather than billing.
 */

export const meta: MetaFunction = () => [{ title: "Help — SourceTrac" }];

const FAQ = [
  {
    q: "Why is the question not showing on my thank-you page?",
    a: "Three things are worth checking. First, the SourceTrac block must be added to the thank-you page in your checkout editor and set to visible. Second, Shopify does not offer the thank-you and order status pages on the Starter plan — check your plan in Shopify admin. Third, if you just installed, it can take a minute for the first order to arrive.",
  },
  {
    q: "Why does a buyer see the question on both the thank-you and order status page?",
    a: "They should not. Once an order has an answer, SourceTrac hides the question everywhere for that order, so each buyer is only ever asked once.",
  },
  {
    q: "Why is one of my answers missing revenue?",
    a: "The buyer answered a moment before Shopify sent us the order, so we had their answer but not the order value yet. Revenue usually appears within a minute. If it is still missing after a day, the answer is shown as waiting rather than counted as zero, so your totals stay honest.",
  },
  {
    q: "What happens to refunded orders?",
    a: "Refunded value is subtracted from the order total before it is attributed, so a refunded order contributes little or nothing. Cancelled and test orders are excluded from revenue entirely. Test orders are also excluded from your response rate.",
  },
  {
    q: "I reached my free limit. Did I lose my answers?",
    a: "No. Answers keep being collected and stored. They are simply held back from your dashboard totals until you upgrade, and they appear immediately once you do.",
  },
  {
    q: "Does SourceTrac ask for anything about my customers?",
    a: "No. We store only the order ID, the channel the buyer picked, and the time. We never collect names, emails or addresses, and there is no customer data in your CSV export.",
  },
  {
    q: "Can I change the question after going live?",
    a: "Yes. Change the wording or options in Settings at any time. The new version applies to the next order. Answers already collected keep their original channel.",
  },
  {
    q: "How do I cancel?",
    a: "Cancel from the Plans page. Your survey keeps working on the Free plan with 50 responses a month, and nothing is deleted.",
  },
];

export default function Help() {
  const [open, setOpen] = useState<string | null>(FAQ[0]?.q ?? null);

  return (
    <s-stack gap="base">
      <s-section heading="Help" subheading="Answers to the questions we get most." padding="none" />

      <Panel title="Frequently asked">
        <s-stack gap="small">
          {FAQ.map((item, index) => {
            const isOpen = open === item.q;
            const panelId = `faq-answer-${index}`;
            return (
              <s-box key={item.q} padding="small" border="base" borderRadius="base">
                <s-stack gap="small">
                  {/* Each question is a real button so it is keyboard reachable
                      and announced as expandable. */}
                  <s-button
                    variant="tertiary"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setOpen(isOpen ? null : item.q)}
                  >
                    {item.q}
                  </s-button>

                  {isOpen ? <s-text id={panelId}>{item.a}</s-text> : null}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </Panel>

      <Panel title="Still stuck?">
        <s-stack gap="small">
          <s-text>
            Email us at{" "}
            <s-link href="mailto:support@sourcetrac.app">support@sourcetrac.app</s-link> and include
            your store domain. We reply within one business day.
          </s-text>
          <s-text color="subdued" fontSize="small">
            Before writing, the fastest fix for a missing survey is usually the checkout editor check
            in the first answer above.
          </s-text>
        </s-stack>
      </Panel>
    </s-stack>
  );
}