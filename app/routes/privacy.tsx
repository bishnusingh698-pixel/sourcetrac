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
      <p>Last updated: 13 October 2026</p>

      <p>
        SourceTrac is a survey app for Shopify. It asks your buyers one question at
        checkout and shows you which channels bring in revenue. This page explains
        what we store and how to have it removed.
      </p>

      <h2>What we store</h2>
      <p>We keep the smallest set of data needed to attribute an order to a channel:</p>
      <ul>
        <li>the Shopify order ID</li>
        <li>the answer the buyer gave, or free text they typed</li>
        <li>the time of the answer</li>
        <li>the order total and currency, read from the order</li>
        <li>the order&apos;s country and the buyer&apos;s language, when the survey uses them</li>
        <li>the customer ID, only when the buyer is logged in and the survey targets returning buyers</li>
      </ul>

      <h2>What we do not store</h2>
      <p>
        We do not store names, email addresses, phone numbers, postal addresses, or
        payment details. We never see card numbers. We do not use the data for
        advertising, profiling, or resale, and we do not sell it.
      </p>

      <h2>Why we store it</h2>
      <p>
        To show you, the merchant, which marketing channels earn revenue. The data
        stays inside your own Shopify admin. No other merchant can see it.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Survey answers and cached orders are deleted after 24 months, and raw
        webhook payloads after 30 days. These periods are fixed and the same for
        every store.
      </p>

      <h2>Deletion</h2>
      <p>
        When you uninstall SourceTrac we delete your access tokens immediately.
        Shopify then sends a redaction request, and we delete your shop&apos;s
        stored data in response — within 48 hours of uninstall.
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
