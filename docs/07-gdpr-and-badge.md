# GDPR posture and Built for Shopify readiness

Written 2026-10-02. Requirements were checked against Shopify's live
documentation, not from memory. Source: [Privacy law compliance](https://shopify.dev/docs/apps/build/privacy-law-compliance)
and [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements).

## Summary

SourceTrac is close to compliant, and the app's data minimisation is its main
advantage. One real defect was found and fixed: `customers/redact` deleted
nothing.

| Area | Status |
| --- | --- |
| Three mandatory compliance webhooks registered | Done |
| Webhook HMAC verified by the library | Done |
| `customers/redact` actually deletes | **Fixed 2026-10-02** |
| `customers/data_request` avoids over-disclosure | **Fixed 2026-10-02** |
| Customer contact details stored | None — by design |
| `read_orders` only, Level 1 protected data | Correct |
| 24-month retention purge job | **Missing** |

## What was actually broken

`customers/redact` is the only mandated webhook that deletes customer-linked
data. The handler received `orders_to_redact` — an array of numeric order IDs —
threw the field away, logged a justification for why it could not act, and
returned zero.

The stated reason was that no customer identifier is stored, so a buyer's rows
could not be found. That reasoning was wrong. Shopify names the exact orders to
redact, and `SurveyResponse.orderId` and `OrderCache.orderId` store
`String(order.id)` from the REST payload — the same numeric ID. The join was
available the whole time.

The practical effect was a GDPR erasure request receiving a 200 response and no
deletion. That is the worst shape of failure: it looks successful.

Now deleted on redaction:

- `SurveyResponse` rows for those orders
- `OrderCache` rows for those orders

Scoped to the shop, so an identical order ID in another shop is never touched.
Covered by `tests/db-compliance.test.ts` (9 tests); five of them fail against
the old implementation.

## What was fixed alongside it

`customers/data_request` returned up to 5,000 order IDs — *every* response on
the shop — for any single customer request. That disclosed one buyer's data
request with other buyers' order IDs, and it grew with the shop.

It now returns no order list at all, and instead states what is held: response
count, cached order count, and a channel breakdown. With no stored identifier
there is no way to scope a response to one individual, so no per-customer list
is produced. That is the honest answer, and it is the smaller disclosure.

## Still missing: the retention purge

The docs promise 24-month retention on responses and orders, and 30 days on
webhook payloads. **No code implements this.** There is no `jobs.server.ts`, no
`deleteMany` outside the redact handlers, and no scheduled endpoint.

Two consequences:

- **Compliance.** The published privacy policy promised a window that does not
  run. Webhook payloads can contain customer fields — exactly what the 30-day
  policy exists to bound.
- **Storage.** The Neon free tier's 0.5 GB is consumed without bound, and the
  capacity estimates in `06-deployment.md` assume a purge that does not exist.

This is the one substantive GDPR gap remaining. It is a self-contained job and
worth doing before App Store review.

## What is genuinely compliant

- **Data minimisation.** No customer name, email, phone, address, or customer
  GID is stored. A response is `order_id`, `channel`, `timestamp`, plus the
  order total and currency cached from the webhook.
- **Scope.** `read_orders` only. No customer scopes, no `write_orders`. This
  keeps the app at protected-customer-data **Level 1**.
- **HMAC.** Webhook verification is delegated to
  `authenticate.webhook()`, which verifies over the raw body and returns 401 on
  a bad signature — the exact behaviour App Store review checks.
- **Token safety.** Access tokens are AES-256-GCM encrypted at rest with IV and
  auth tag, and nulled on `app/uninstalled`.
- **Co-Processor Agreement.** Signed with the Partner team. Required before
  review; not a code change.
- **Sub-processors** are disclosed: Neon, Render, Shopify.

### Level 1 obligations still outstanding

- **Retention periods must be documented and enforced.** Documented; not
  enforced. See above.
- **Merchant consent** — merchants must opt in to Level 1 protected data. If
  your app was created before the requirement, merchants may not have been
  asked. Check the Partner Dashboard.

## Built for Shopify

Honest read: the badge is not the current bottleneck, and GDPR compliance is a
prerequisite for it, not a route to it.

**The hard gate:** at least **50 net installs from active shops on paid plans**.
Most of the remaining criteria are also volume-dependent:

| Criterion | Requirement |
| --- | --- |
| Checkout performance | p95 ≤ 500ms and ≤ 0.1% failures over **1,000+ requests in 28 days** |
| INP | ≤ 200ms over **100+ calls in 28 days** |
| Merchant adoption | 50 paid installs |

Performance is assessed automatically once enough traffic exists. Note the
app's own 60-second cold-start budget is an advantage here — it runs inside a
surge, and p95 is measured per request.

Category-specific criteria also apply. SourceTrac sits in analytics/
attribution, and the app uses checkout UI extensions, which is the right
modern surface.

Check the current, exact status on the app's **Distribution page in the Partner
Dashboard** — most criteria are self-evaluated there.

## Suggested order

1. Implement the retention purge. Closes the last GDPR gap and protects the
   free-tier storage.
2. Get the Co-Processor Agreement signed.
3. Confirm merchant consent for Level 1 protected data.
4. `shopify app deploy`, then submit for review.
5. Chase installs toward 50 paid. The badge follows review, not precedes it.