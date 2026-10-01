# SourceTrac — Manual QA checklist (development store)

Every row maps to a documented failure mode in `docs/03-logic-spec.md`. Run in
order; steps 1–3 gate everything after them.

Legend: **[A]** automated (`npm test`), **[M]** manual on a dev store.

---

## 0. Prerequisites

- [ ] **[M]** Dev store on Basic (or Grow/Advanced/Plus). Do **not** use Starter for
      the main pass — see §9.
- [ ] **[M]** Test product with a price, and one test order completed end to end.
- [ ] **[M]** `shopify app dev` running, or a deployed Render service reachable.

---

## 1. Install and onboarding

- [ ] **[M]** Install from the Partner Dashboard or dev CLI. App opens in the admin
      without a redirect loop.
- [ ] **[M]** Onboarding shows three steps with step 1 marked as needing merchant
      action and a deep link to the checkout editor.
- [ ] **[M]** Clicking the deep link lands on the checkout editor with the app's
      block available.
- [ ] **[M]** Every nav item loads: Dashboard, Get started, Settings, Export, Plans,
      Help. No dead links, no 500s.

## 2. Survey appears in checkout

- [ ] **[M]** Place the block on the **Thank you** page in the editor. Complete a
      real order. The survey renders with the question and 6 options.
- [ ] **[M]** Options render in the order set in Settings, with the chosen emoji.
- [ ] **[M]** Tap one option → submits → "Thanks!" confirmation → block collapses.
- [ ] **[M]** The thank-you page order summary, tracking and totals are **unchanged**
      and not visually displaced by the block.
- [ ] **[M]** Enable the block on the **Order status** page; view the same order from
      the customer's order-status page. The survey does **not** reappear for an order
      already answered (Flow 1).
- [ ] **[M]** Block inherits checkout theme: fonts and colours match the merchant's
      theme, no default-blue styling, no layout break at mobile width.

## 3. Submission integrity (Flow 1, 2)

- [ ] **[M]** Double-tap an option rapidly. Exactly one response is stored.
- [ ] **[M]** Submit, then refresh the thank-you page. No duplicate row, no error.
- [ ] **[M]** Check the Export CSV: one row for that order, not two.
- [ ] **[M]** Answer with a free-text "Other" value; confirm the CSV shows the channel
      as `other` and the text is not dropped.

## 4. Attribution and revenue (Flow 6, 7)

- [ ] **[M]** Dashboard revenue for the answered channel equals the order total.
- [ ] **[M]** A test order answered in checkout does **not** add revenue.
- [ ] **[M]** Refund an order fully → it leaves revenue; partially → revenue is net.
- [ ] **[M]** Cancel an order → no revenue.
- [ ] **[A]** Currency separation: a store with two presentment currencies shows two
      revenue lines and never a combined figure.

## 5. Backend resilience (Flow 8, 9)

- [ ] **[M]** Stop the backend, answer the survey on the thank-you page. The block
      stays usable, shows no error, and disappears only after the retry budget.
- [ ] **[M]** Restart the backend, answer again. Response is stored.
- [ ] **[M]** Cold start: with the service fully asleep, the first load of the survey
      takes up to ~60s to appear but **never blocks or errors the thank-you page**.
- [ ] **[M]** `GET /healthz` returns 200 in under 100ms and does not query Postgres.

## 6. Auth and abuse (Flow 4, 12)

- [ ] **[M]** `POST /api/responses` with no `Authorization` header → 401.
- [ ] **[M]** With an expired/garbage token → 401, and the log records it.
- [ ] **[M]** Rapid-fire submissions from one order are rate-limited, not crashed.

## 7. Uninstall and data (Flow 10)

- [ ] **[M]** Uninstall the app. A `shop/redact` clears tokens and customer data.
- [ ] **[M]** Reinstall. Onboarding is fresh; prior attribution is gone per the
      documented retention policy.

## 8. Plans (Flow 11)

- [ ] **[M]** Free plan: at 40/50 responses the upgrade banner appears (80%).
- [ ] **[M]** At 50/50 the banner states the cap is reached; the survey still
      collects and the response is flagged, not dropped.
- [ ] **[M]** Upgrade to Growth through Shopify's hosted confirmation. The admin
      reflects the new plan after the billing webhook lands.
- [ ] **[M]** Cancel. The app degrades to Free behaviour without data loss.

## 9. Unsupported plan (Flow 13)

- [ ] **[M]** On a **Starter** store, onboarding explains clearly why the survey
      cannot appear and what to do, with no dead end.

## 10. Accessibility and localisation

- [ ] **[M]** Keyboard-only: every option is reachable and activatable; focus is visible.
- [ ] **[M]** Screen reader announces the question, each option, and the confirmation.
- [ ] **[M]** Localise the store to a non-English language; the survey renders in the
      buyer's language.

## 11. Admin edge cases (Flow 14)

- [ ] **[M]** Brand-new store with zero responses: Dashboard, Settings, Export and
      Plans all show designed empty states, not blank or zero-division output.
- [ ] **[M]** Save fewer than 6 or more than 10 options → inline error that says how
      to fix it.
- [ ] **[M]** Enter a duplicate option ("Instagram" and "instagram") → inline error.
- [ ] **[M]** Export with zero responses downloads a header-only CSV.

---

## Known constraints (not bugs)

- Onboarding step 1 cannot self-verify — the Admin API exposes no state for whether a
  checkout block is enabled, and Shopify sends no webhook when a merchant toggles it.
  The step stays open with a link to the editor and says so honestly.
- The survey only records the tapped option. It never reads buyer PII, so it does not
  depend on protected-customer-data approval for the survey itself.