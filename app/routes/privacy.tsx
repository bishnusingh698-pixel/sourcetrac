/**
 * Public privacy policy.
 *
 * Shopify requires a reachable privacy policy URL for App Store review. It is
 * deliberately a server-rendered document with no embedded app chrome so it
 * loads for a logged-out reviewer.
 */

export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", lineHeight: 1.6 }}>
      <h1>SourceTrac Privacy Policy</h1>
      <p>
        <strong>Last updated:</strong> 1 October 2026
      </p>

      <h2>What SourceTrac collects</h2>
      <p>SourceTrac collects the minimum needed to attribute an order to a channel:</p>
      <ul>
        <li>The Shopify order ID</li>
        <li>The answer the buyer selected (a channel name you defined, or free text)</li>
        <li>The timestamp of the answer</li>
        <li>The order total and currency, cached from Shopify</li>
      </ul>
      <p>
        SourceTrac does <strong>not</strong> collect buyer names, email addresses, phone
        numbers, addresses, or payment details. It never sees or stores payment card data.
      </p>

      <h2>Why we collect it</h2>
      <p>
        To show you, the merchant, which marketing channels bring in revenue. This is
        business analytics, not advertising. We do not use this data for advertising,
        profiling, or data brokerage, and we do not sell it.
      </p>

      <h2>Who can see the data</h2>
      <p>
        Only the Shopify merchant who installed SourceTrac. We do not share buyer answers
        with third parties.
      </p>

      <h2>Data retention</h2>
      <p>
        When you uninstall SourceTrac, your shop's data and access tokens are deleted.
        Buyers may also request deletion of their data through the merchant. We
        action that request through Shopify's mandatory compliance webhooks: when
        Shopify sends a redaction request naming the orders that belong to that
        buyer, we delete the matching survey responses and cached order rows
        immediately, and only those.
      </p>

      <h2>Sub-processors</h2>
      <ul>
        <li>
          <strong>Neon</strong> — database hosting
        </li>
        <li>
          <strong>Render</strong> — application hosting
        </li>
        <li>
          <strong>Shopify</strong> — the commerce platform providing the data
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have rights to access, correct, export, or
        delete your personal data, or to object to its processing. Because SourceTrac does
        not collect identifying buyer data, most requests are handled entirely by the
        merchant. To make a request about data held by SourceTrac, contact the merchant
        who installed the app.
      </p>

      <h2>Contact</h2>
      <p>
        For privacy questions, contact us at <a href="mailto:privacy@sourcetrac.app">privacy@sourcetrac.app</a>.
      </p>
    </main>
  );
}