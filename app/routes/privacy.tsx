import type { MetaFunction } from "react-router";

import { SUPPORT_EMAIL } from "@shared/support";

/**
 * Public privacy policy.
 *
 * Shopify requires a reachable privacy policy URL for App Store review. It is
 * deliberately a server-rendered document with no embedded app chrome and no
 * database reads, so it loads for a logged-out reviewer. The text describes only
 * what the app actually does; it is not legal advice and the founder should
 * review it before publishing the listing.
 */

export const meta: MetaFunction = () => [
  { title: "SourceTrac privacy policy" },
  {
    name: "description",
    content: "What SourceTrac stores, why, how long, and how to have it deleted.",
  },
];

export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", lineHeight: 1.6 }}>
      <h1>SourceTrac privacy policy</h1>
      <p>Last updated: 15 October 2026</p>

      <p>
        SourceTrac is a survey app for Shopify. It asks your buyers a short survey
        after checkout and shows you which channels bring in revenue. This page explains
        what we store and how to have it removed.
      </p>

      <h2>What we store</h2>
      <p>We keep the smallest set of data needed to attribute an order to a channel:</p>
      <ul>
        <li>the Shopify order ID and order number</li>
        <li>the answers the buyer gave, including any text they typed</li>
        <li>the time of the answer and the page it was given on</li>
        <li>the order total, currency and status (paid, refunded, cancelled or test), read from the order</li>
        <li>the buyer&apos;s checkout country and language</li>
        <li>the products in the order, and whether it was the buyer&apos;s first order</li>
      </ul>

      <h2>What we do not store</h2>
      <p>
        We do not store names, email addresses, phone numbers, postal addresses, or
        payment details. We never see card numbers. We do not use the data for
        advertising, profiling, or resale, and we do not sell it.
      </p>

      <h2>Why we store it</h2>
      <p>
        To show you, the merchant, which marketing channels earn revenue. No other
        merchant can see it. It leaves SourceTrac only when you download a CSV
        export, or when you turn on Shopify actions, which copy answers into your
        own store as order tags, customer tags, customer metafields or a Shopify
        Flow trigger.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Survey answers and cached orders are deleted after 24 months, and webhook
        delivery records (which hold no order or buyer details) after 30 days. These periods are fixed and the same for
        every store.
      </p>

      <h2>Deletion</h2>
      <p>
        When you uninstall SourceTrac we delete your access tokens immediately.
        Shopify sends a redaction request 48 hours after uninstall, and we delete
        your shop&apos;s stored data when it arrives.
      </p>
      <p>
        A buyer can ask for their data to be removed through you, the merchant. We
        act on that request through Shopify's mandatory compliance webhooks. When
        Shopify sends a redaction request naming a buyer's orders, we delete the
        matching survey answers and cached order rows, and only those.
      </p>

      <h2>Who processes the data</h2>
      <ul>
        <li>Neon — database hosting</li>
        <li>Render — application hosting</li>
        <li>Shopify — the platform the data comes from</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct,
        export, or delete your personal data, or to object to its processing.
        Because SourceTrac does not collect identifying buyer data, most requests are
        handled by the merchant who installed the app. To make a request about data
        held by SourceTrac, contact us at the address below.
      </p>

      <h2>Contact</h2>
      <p>
        For privacy questions, email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </main>
  );
}
