# SourceTrac — Architecture, Data Model & Costs

Companion to `01-verification-report.md`. Read that first; every choice below traces to a finding ID there.

---

## 1. System shape

```
                    ┌─────────────────────────────────────────┐
  Buyer ───────────▶│ Shopify Thank-you page                   │
  (post-purchase)   │  └─ checkout_ui extension                │
                    │     source-trac-checkout-ui              │
                    │     target: purchase.thank-you.block.render│
                    └────────────────┬────────────────────────┘
                                     │ shopify.sessionToken.get() → JWT
                                     │ fetch POST /public/survey-config
                                     │ fetch POST /public/responses
                     ┌───────────────▼────────────────────────┐
  Buyer ───────────▶│ Shopify Order status page                │
                     │  └─ customer_account_ui extension       │
                     │     source-trac-checkout-ui             │
                     │     target: customer-account.order-status.block.render│
                     └───────────────┬────────────────────────┘
                                     │ same two endpoints, same JWT
                                     ▼
        ╔══════════════════════════════════════════════════╗
        ║  Backend  (Render free web service, Node 22)      ║
        ║  • GET  /healthz          ← NO database access   ║
        ║  • POST /public/survey-config                     ║
        ║  • POST /public/responses                         ║
        ║  • POST /webhooks        ← HMAC verified          ║
        ║  • app/* routes          ← embedded admin (React) ║
        ╚═══════════════════╤══════════════════════════════╝
                            │ pooled connection
                            ▼
        ╔══════════════════════════════════════════════════╗
        ║  Postgres on Neon (serverless, pooled)            ║
        ║  shops · survey_responses · orders_cache          ║
        ║  webhook_events · billing_usage                    ║
        ╚══════════════════════════════════════════════════╝

  Shopify ──orders/create, orders/updated, orders/cancelled,
            app/uninstalled, customers/data_request,
            customers/redact, shop/redact──▶ /webhooks
```

### Why this split

- **The extension never calls the Admin API.** It calls our backend with a session-token JWT. Shopify docs warn that a session token "only guarantees the integrity of its claims. It does not guarantee the request itself originated from Shopify", so the backend treats `dest` as the authoritative shop identity and nothing else.
- **Order totals arrive via webhook, not via the extension.** Shopify confirms the order "is not yet created" on the Thank-you page when the extension renders. Fetching the order from the extension is therefore racy. `orders/create` is the source of truth for revenue.
- **`/healthz` touches no database.** Verified requirement from your prompt: the uptime pinger must not wake Neon. The endpoint returns process liveness from memory only.

---

## 2. Public API surface

Three unauthenticated-by-session, authenticated-by-JWT endpoints. All three set `Access-Control-Allow-Origin: *` (finding A10) because the extension's origin is not stable.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | none | Liveness. Returns `{ok:true, uptime_s}`. **Zero DB calls, zero imports of the DB client at request time.** |
| GET | `/public/survey-config` | `Authorization: Bearer <session JWT>` | Returns question text, options, emoji, `allow_other`, and the shop's `currency` + `supported`. 304-friendly: returns `ETag`. |
| POST | `/public/responses` | `Authorization: Bearer <session JWT>` | Records one response. Idempotent on `(shop_id, order_id)`. Returns `{status:"recorded"\|"duplicate"\|"locked"}`. |
| POST | `/webhooks` | HMAC-SHA256 | Shopify → us. Idempotent on `X-Shopify-Webhook-Id`. |
| POST | `/public/other-response` | JWT | Free-text "Other" answer, sent separately so a long text field never blocks the one-tap path. |

Design note: `survey-config` exists so the extension can render the merchant's copy **without a round trip to Shopify**, and so we can return `supported:false` for Starter stores without the extension guessing.

---

## 3. Data model

Prisma, Postgres. Every table is scoped by `shop_id`.

### `shops`
| Column | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `shop_domain` | `String` **unique** | e.g. `acme.myshopify.com` |
| `shop_id` | `String` **unique** | from `shop_id` in payload / GID |
| `access_token_encrypted` | `String` | AES-256-GCM. Key = `TOKEN_ENCRYPTION_KEY` env. Never logged. |
| `plan` | `String` | `free` \| `growth` \| `scale` — cached, not authoritative (Billing API is) |
| `plan_status` | `String` | `active`\|`cancelled`\|`declined`\|`frozen`\|`expired` |
| `subscription_gid` | `String?` | `gid://shopify/AppSubscription/...` |
| `question_text` | `String` | default `How did you hear about us?` |
| `options_json` | `String` | JSON array of `{value, emoji, label}` — 6–10 items |
| `allow_other` | `Boolean` | default false |
| `checkout_supported` | `Boolean?` | null = unknown, re-checked on next admin load |
| `plan_display_name` | `String?` | from `shop.plan.publicDisplayName` |
| `created_at` / `updated_at` | `DateTime` | |

### `survey_responses`
| Column | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `shop_id` | `String` | FK → shops.id |
| `order_id` | `String` | **Shopify order GID.** `@@unique([shop_id, order_id])` — this is the double-tap guard. |
| `channel` | `String` | the option `value` slug, or `other` |
| `other_text` | `String?` | max 200 chars, sanitised |
| `currency` | `String?` | ISO code, copied from `orders_cache` at reconcile time |
| `order_total` | `Decimal?` | `Decimal(12,2)`. Null until the webhook lands. |
| `locale` | `String?` | buyer's checkout locale, for analytics only |
| `submitted_at` | `DateTime` | buyer's submission time (UTC) |
| `is_locked` | `Boolean` | true when the Free cap was already exceeded — data kept, upgrade prompted in admin |
| `created_at` | `DateTime` | |

### `orders_cache`
| Column | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `shop_id` | `String` | |
| `order_id` | `String` | **unique with shop_id** |
| `order_number` | `String?` | |
| `currency` | `String` | **required.** Never null — this is the currency-separation guarantee. |
| `total_price` | `Decimal(12,2)` | |
| `total_refunded` | `Decimal(12,2)` | default 0 |
| `financial_status` | `String?` | `paid`, `partially_refunded`, `refunded`, `voided`, … |
| `is_test` | `Boolean` | from order `test` flag |
| `is_cancelled` | `Boolean` | |
| `cancelled_at` | `DateTime?` | |
| `created_at_shop` | `DateTime` | Shopify's `created_at`, not ours |
| `updated_at_shop` | `DateTime` | for out-of-order webhook reconciliation |

### `webhook_events`
| Column | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `shop_id` | `String?` | |
| `webhook_id` | `String` **unique** | `X-Shopify-Webhook-Id`. Insert-first = idempotency. |
| `topic` | `String` | |
| `api_version` | `String?` | from `X-Shopify-Api-Version` |
| `payload_json` | `String` | raw, for post-mortems |
| `processed_at` | `DateTime?` | |
| `error` | `String?` | |

### `billing_usage`
| Column | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `shop_id` | `String` | |
| `period_start` / `period_end` | `DateTime` | UTC month boundaries |
| `responses_count` | `Int` | incremented on successful insert |
| `cap` | `Int?` | 50 on free, null (unlimited) on paid |
| `updated_at` | `DateTime` | |
| | | **`@@unique([shop_id, period_start])`** |

### Indexes
- `survey_responses`: `(shop_id, submitted_at)` for trends; `(shop_id, channel)` for grouping; `(shop_id, is_locked)`.
- `orders_cache`: `(shop_id, updated_at_shop)` for reconciliation sweeps.
- `webhook_events`: unique on `webhook_id`; `(shop_id, created_at)` for retention sweeps.
- Partial index on `survey_responses` where `order_total IS NOT NULL` — revenue queries only touch reconciled rows.

---

## 4. Access scopes — minimal set, each justified

| Scope | Why SourceTrac needs it |
|---|---|
| `read_orders` | Receive `orders/create`, `orders/updated`, `orders/cancelled` payloads. Cache `total_price`, `currency`, `financial_status`. **Read-only.** No order is ever written. |

That's the entire list. Explicitly **not** requested, and why:

| Not requested | Reason |
|---|---|
| `write_orders` | We never mutate an order. Checkout UI extensions have no order-mutation API anyway (A4 limitation note). |
| `read_all_orders` | App Store requirement 3.2.1 demands proof of need. We only need orders **that have a survey response**, which we already have by `order_id`. |
| `read_customers` / `write_customers` | We store no customer data. `customers/data_request` and `customers/redact` are answered with "we hold no customer data for this customer" plus any order-level redaction. |
| `read_products`, `read_all_products` | No product data. |
| `read_checkout` | Not needed — the extension gets the order GID from `OrderConfirmationApi`/`OrderStatusApi`. |

---

## 5. Protected customer data position

SourceTrac is **Level 1**: order data relating to a single customer, excluding name/address/phone/email.

Data actually collected — exactly three things, per your prompt:
- `order_id` (opaque GID)
- `channel` (one of the merchant's own option slugs)
- `submitted_at` (timestamp)

Plus two derived-from-order fields needed for the product's core promise (revenue per channel): `order_total` and `currency`.

**What we never store:** customer name, email, phone, any address, payment details, line items, product titles, IP addresses of buyers, user agents, or free-text other than the optional "Other" box (max 200 chars, sanitised, and surfaced to the merchant only).

**Justification text for the Partner Dashboard (Level 1):**

> SourceTrac collects order data solely to attribute real order revenue to the marketing channel a buyer selected in a post-purchase survey. We request `read_orders` to receive `orders/create` webhooks containing the order total and currency; we cache only `order_id`, `total_price`, `currency`, `financial_status`, and cancellation state. We never read or store customer name, email, phone, address, payment details, or line items, and we do not request Level 2 protected fields. Responses are stored without any customer identifier. Data is encrypted at rest (Neon managed encryption) and in transit (TLS 1.2+ at Render). Retention is 24 months rolling, after which responses are deleted. Buyers may withdraw consent via the merchant; the `customers/redact` webhook deletes their order-linked response rows within the Shopify-mandated window.

### Retention
- `survey_responses`, `orders_cache`: **24 months rolling**, purged by a daily job. Satisfies Level 1 requirement 8.
- `webhook_events`: **30 days**, purged. Payload may contain customer fields; we don't want it lying around.
- Encrypted access tokens: deleted **on `app/uninstalled`** and again on **`shop/redact`** (48h after uninstall).

---

## 6. Real monthly cost

Assumptions: 200 merchant installs, 2,000 orders/month total, ~60% survey response rate → ~1,200 responses/month, all on the free Render tier.

| Component | Plan | Cost | Source |
|---|---|---|---|
| Backend | Render free web service (512 MB, 0.1 CPU, 750 hrs/workspace/mo) | **$0.00** | render.com/pricing, render.com/docs/free |
| Database | Neon Free (100 CU-hrs/project, 0.5 GB, 5 GB egress) | **$0.00** | neon.com/docs/introduction/plans |
| Domain | — | $0.00 | Render provides `*.onrender.com` TLS |
| Shopify CLI | open source | $0.00 | |
| **Total** | | **$0.00 / month** | |

### What it actually costs you in practice

$0 in infrastructure is not $0 in risk. Two real costs:

1. **Your uptime pinger.** Whatever service you use costs money (often a free tier, sometimes not). This is the single line item that can make the bill non-zero.
2. **Your time.** Cold starts mean the extension must tolerate ~60s failures. That retry code is the price of $0.

### Break-even analysis
If you ever exceed Neon Free's 100 CU-hours or 0.5 GB, you move to **Neon Launch at $0.106/CU-hour**. 100 CU-hours is roughly 1,800 hours at 0.25 CU — far more than this app needs. Realistically you will not pay Neon before you have thousands of installs.

Render's paid escape hatch is **$7/month** for <1 CPU / 512 MB, which removes all cold starts. **Recommendation: stay on free until you have real revenue, then spend the $7.** $7 removes an entire class of failure from your support burden.

### Two non-sleeping alternatives (verified)

**Alternative 1 — Northflank Sandbox (recommended).**
> "Sandbox for testing and building trust with Northflank: **Always-on-compute – no sleeping**, 2× free services, 1× free database, 2× free cron jobs"

Limits on the Developer/Sandbox tier: 2 projects, 2 services, 2 jobs, 1 addon, "Limited" compute. Paid rates if you outgrow: $0.01667/vCPU/hr, $0.00833/GB/hr, $0.06/GB egress, $0.15/GB/mo disk. A 0.5 vCPU / 1 GB service costs **$12.00/month** on pay-as-you-go.
Source: https://northflank.com/pricing

**Alternative 2 — Koyeb (fallback, with a caveat).**
Koyeb's own pricing page lists only paid org plans ($29/mo Pro with $10 included compute; $299/mo Scale). **A free web-service tier is not currently listed.** Their Serverless Postgres has a confirmed free instance: "Free 5h / 0.25 vCPU / 1 GB RAM / 1GB / $0/mo" — 5 hours/month, which is not enough for a production database.
Source: https://www.koyeb.com/pricing

**Rejected:**
- **Fly.io** — pricing page documents no free allowance for new organizations; all orgs require a credit card.
- **Oracle Always Free** — Oracle's community announcement says A1 dropped to 2 OCPU / 12 GB on 2026-08-18; Oracle's own service-limits doc still shows a 96 GB free-tier value for the same limit. The sources contradict each other, and self-managed OCI means no managed TLS and no git deploy.

### The cold-start contract (this is the important part)

Your uptime pinger keeps Render warm. **We do not depend on it.** Concretely:

| Layer | Behaviour during a 60–90s cold start |
|---|---|
| `GET /healthz` | Answers immediately once the process is up. Does not touch Neon. |
| `POST /public/survey-config` | Extension retries: attempt at t=0, then backoff 1s, 2s, 4s, 8s, 15s, 15s… |
| `POST /public/responses` | Extension retries with the same schedule, holding the answer in memory. On final failure: logs, hides the survey, **never blocks or breaks the page**. |
| Neon itself | Wakes on connect (~1s). Retried requests absorb this. |

Retry budget: **~60 seconds wall clock, 8 attempts, exponential with jitter, capped at 15s.** After the last attempt the extension hides the survey and logs `{event:'survey_submit_failed', order_id, attempts}`. No buyer ever sees a spinner they can't dismiss, and no buyer is blocked.

---

## 7. File tree

```
sourcetrac/
├── shopify.app.toml
├── shopify.extension.toml            (generated per-extension)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── Dockerfile
├── .env.example
├── README.md
├── docs/
│   ├── 01-verification-report.md
│   ├── 02-architecture-and-costs.md          ← you are here
│   ├── 03-logic-spec.md
│   ├── 04-file-tree.md
│   └── 05-manual-qa-checklist.md
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   │   ├── 20260101000000_init/migration.sql
│   │   └── migration_lock.toml
│   └── seed.ts
├── app/
│   ├── root.tsx
│   ├── shopify.server.ts
│   ├── db.server.ts
│   ├── session.server.ts
│   ├── entry.server.tsx
│   ├── routes.ts
│   ├── lib/
│   │   ├── logger.ts               structured JSON logging
│   │   ├── errors.ts               AppError hierarchy + central handler
│   │   ├── env.ts                  zod-validated env
│   │   ├── crypto.server.ts        AES-256-GCM token encryption
│   │   ├── hmac.server.ts          webhook HMAC verify
│   │   ├── session-token.server.ts extension JWT verification
│   │   ├── rate-limit.server.ts    token bucket
│   │   ├── retry.server.ts         backoff for Admin API + Postgres
│   │   ├── shopify.server.ts       Admin GraphQL client w/ 429 handling
│   │   ├── money.ts                currency-safe formatting & grouping
│   │   ├── analytics.ts            AOV, response rate, trends
│   │   ├── settings.ts             option validation (6–10)
│   │   ├── plans.ts                plan definitions + caps
│   │   ├── billing.server.ts       Billing API subscriptions
│   │   └── jobs.server.ts          retention purge + reconciliation
│   ├── routes/
│   │   ├── healthz.ts                       ← NO DB
│   │   ├── public.survey-config.ts
│   │   ├── public.responses.ts
│   │   ├── public.other-response.ts
│   │   ├── webhooks.ts
│   │   └── app/
│   │       ├── app.tsx                      layout + nav
│   │       ├── app._index.tsx               onboarding
│   │       ├── app.dashboard.tsx
│   │       ├── app.settings.tsx
│   │       ├── app.export.tsx
│   │       ├── app.plans.tsx
│   │       ├── app.help.tsx
│   │       └── auth.$.tsx                  OAuth callback
│   └── components/                  Polaris Web Components wrappers
│       ├── AppPage.tsx
│       ├── EmptyState.tsx
│       ├── ErrorState.tsx
│       ├── Skeleton.tsx
│       ├── Toast.tsx
│       ├── UpgradeBanner.tsx
│       ├── StatCard.tsx
│       └── ChannelTable.tsx
├── extensions/
│   ├── checkout-ui/                        purchase.thank-you.block.render
│   │   ├── shopify.extension.toml
│   │   ├── src/ThankYou.tsx
│   │   ├── src/Survey.tsx
│   │   ├── src/api.ts                     retry/backoff client
│   │   ├── src/state.ts                    in-memory answer + dedupe
│   │   └── locales/en.default.json
│   └── customer-account-ui/                customer-account.order-status.block.render
│       ├── shopify.extension.toml
│       ├── src/OrderStatus.tsx
│       ├── src/Survey.tsx                  (shared logic, thin wrapper)
│       ├── src/api.ts
│       └── locales/en.default.json
├── tests/
│   ├── unit/
│   │   ├── money.test.ts
│   │   ├── analytics.test.ts
│   │   ├── settings-validation.test.ts
│   │   ├── hmac.test.ts
│   │   ├── session-token.test.ts
│   │   ├── crypto.test.ts
│   │   ├── rate-limit.test.ts
│   │   ├── retry.test.ts
│   │   ├── response-idempotency.test.ts
│   │   ├── webhook-idempotency.test.ts
│   │   ├── reconciliation.test.ts
│   │   ├── revenue-treatment.test.ts
│   │   └── billing-caps.test.ts
│   ├── integration/
│   │   ├── extension-to-backend.test.ts
│   │   └── cold-start.test.ts
│   └── helpers/
│       ├── db.ts
│       ├── jwt.ts
│       └── server.ts
└── scripts/
    ├── purge.ts
    └── verify-config.ts
```

---

## 8. Decisions worth arguing about

I'll state these plainly so you can push back:

1. **Two extension directories, not one.** Shopify's own tutorial does one. I split them because the targets live in different API namespaces. Cost: a little duplicated wiring, mitigated by an identical `api.ts`/`state.ts` pair. Benefit: lower risk of a rejected config.

2. **`survey_responses.order_total` is nullable.** Denormalising revenue onto the response row makes the dashboard a single indexed query instead of a join across a large `orders_cache`. The cost is reconciliation logic. I think that's the right trade at this scale, and it's the reason the "response before webhook" flow is a first-class spec section rather than an afterthought.

3. **Manual Billing API over Shopify App Pricing.** You asked for it, and it's compliant. But Shopify steers new public apps toward App Pricing, and App Pricing has a real advantage: no `confirmationUrl` redirect dance. If review feedback pushes us there, the migration is one module (`billing.server.ts`) plus a partner client. I've noted the seam.

4. **`read_orders` and nothing else.** Product reviews and surveys usually want customer email for follow-up. We don't. That single decision is what keeps us at Level 1 and makes the privacy review short.

5. **No colour picker, ever.** Not a roadmap item — a permanent "no". Documented as a platform constraint so we don't relitigate it during onboarding.
