# SourceTrac — Compliance and data handling

## What we collect

| Field | Source | Why |
|---|---|---|
| Order ID | Checkout extension target API | Links an answer to revenue. Not identifying on its own. |
| Channel value | Buyer's tap | The answer itself. Free text only if the merchant enables "Other". |
| Timestamp | Server clock (UTC) | Trend windows and CSV. |
| Order total + currency | `orders/create` webhook | Revenue attribution. |

We deliberately do **not** collect buyer name, email, phone, address, or payment data.

## Scopes

`read_orders` — the single requested scope.

**Justification:** the app caches order totals so the dashboard can attribute
revenue to a channel without re-querying Shopify on every page load. We read
order totals only. We never write to an order, and we request no other scope.
Because we cache only the total and currency, v1.0 does not require protected
customer data approval. If a future version needs order PII, that becomes a
separate approval request.

## GDPR webhooks

Registered as `compliance_topics` in `shopify.app.toml`:

- `customers/data_request` — export any data we hold for that customer.
- `customers/redact` — delete it.
- `shop/redact` — clear all shop data and tokens on uninstall.

## Access tokens

Stored encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`), with ciphertext, IV
and auth tag in separate columns. The plaintext is never logged.

## Retention

On uninstall, `shop/redact` deletes shop rows, responses, cached orders and
tokens. There is no separate retention window — removal is immediate on
uninstall, which is stricter than a scheduled purge.

## Listing-copy constraints

The App Store description makes no performance, accuracy or comparative claims
about other apps, and cites no statistics. It describes only what the app does.