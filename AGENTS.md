# SourceTrac — Project Memory

SourceTrac is a Shopify post-purchase attribution survey app (one question: "How did you hear about us?") mapping answers to real order revenue. Target: small merchants, 100–2,000 orders/month.

## Build phases (do NOT skip; user says "continue" between phases)

1. **Phase 1 — DONE** (2026-10-01). Research + architecture + costs + logic spec + file tree, in `docs/`.
2. Phase 2 — Backend, DB, webhooks, billing, healthz.
3. Phase 3 — Checkout UI Extension + Customer Account UI Extension.
4. Phase 4 — Admin UI (onboarding, dashboard, settings, export, plans, help).
5. Phase 5 — Tests, QA checklist, `.env.example`, `shopify.app.toml`, deploy steps, listing copy, submission checklist.

Read `docs/01-verification-report.md` before writing any code — it contains the sourced facts and four conflicts with the original brief that shape the architecture.

## Hard-won facts (verified 2026-10-01, see docs/01 for source URLs)

- **API version `2026-07`** is latest stable. 2026-10 is RC only.
- **React Router template**, not Remix. `shopify app init` → "Build a React Router app".
- **Two extension directories, not one.** `purchase.thank-you.block.render` is a Checkout UI Extension; `customer-account.order-status.block.render` is a Customer Account UI Extension. Different API namespaces.
- **Thank-you + Order-status extensions work on all plans except Shopify Starter.** (Confirmed.)
- **`network_access` requires Partner Dashboard opt-in** (API access → "Allow network access in checkout UI extensions"). Self-serve, auto-approved, but a **deploy blocker** if not done.
- **Extensions need `Access-Control-Allow-Origin: *`** — they run in a Web Worker with an unstable origin.
- **Session tokens are JWTs, TTL 5 minutes.** Trust only `dest` (shop domain), `aud`, `exp`. Never trust shop identity from the body.
- **Polaris React is DEPRECATED/archived.** Use **Polaris Web Components** (`s-page`, `s-section`, `s-button`, …) with `@shopify/polaris-types`.
- **Billing:** Shopify App Pricing stopped sending billing webhooks and stopped passing `charge_id` on **2026-04-28**. We use the **Billing API** (`appSubscriptionCreate`) — still supported, compliant with requirement 1.2.1. Migration seam is `app/lib/billing.server.ts`.
- **`read_orders` is our only access scope.** No `write_orders`, no `read_all_orders`, no customer scopes. This keeps us at protected-customer-data **Level 1**.
- **"Custom branding" in the survey is impossible** — CSS cannot be overridden; merchant checkout branding is inherited. Offer copy + emoji control only. Permanent "no" to a colour picker.
- **Render free:** 512 MB, spins down after 15 min idle, ~1 min cold start, 750 hrs/workspace/mo. **Neon free:** 100 CU-hrs, 0.5 GB, suspends after 5 min inactivity.
- **Non-sleeping alternative: Northflank Sandbox** (explicitly "always-on-compute – no sleeping", 2 free services). Fly.io free tier is gone for new orgs; Koyeb free tier is not on their pricing page; Oracle Always Free sources contradict each other.
- **Total infra cost: $0/month.** The only real cost is the uptime pinger the user runs.

## Non-negotiable logic rules (full spec in docs/03)

- `/healthz` **must never touch the database** — the user's uptime pinger must not wake Neon.
- Duplicate submissions return **HTTP 200 `{status:"duplicate"}`**, not 409. Never create a second row. `@@unique([shop_id, order_id])`.
- Responses can arrive **before** `orders/create` (the order isn't created yet on the Thank-you page). Store with null revenue, show "Pending" — never fake `$0.00`. Reconcile when the webhook lands.
- Webhook idempotency is **insert-first** on `X-Shopify-Webhook-Id` so a retry can redo partial work.
- Extension retry: 8 attempts, exponential + jitter, ~60s budget, then hide and log. **Never block the page. Never lose the answer.**
- Free cap reached → **still collect**, set `is_locked=true`, prompt in admin. Never lose buyer data, never hide the merchant's own data to create urgency.
- **Never sum revenue across currencies.** `GROUP BY currency`. No conversion.
- All period boundaries are **UTC**. Half-open intervals `[start, end)`.
- Refunded/cancelled/test orders excluded from revenue at **read time**; refunded = net of refunds.
- Retention: responses/orders 24 months, webhook payloads 30 days, access token nulled on `app/uninstalled`, full cascade delete on `shop/redact`.

## Compliance posture

- Store only: `order_id`, `channel`, `submitted_at`, plus `order_total` + `currency` from the order webhook. No customer name/email/phone/address, ever.
- Mandatory GDPR webhooks implemented: `customers/data_request`, `customers/redact`, `shop/redact`.
- Listing copy must contain **no unverified statistics and no competitor claims**.

## Conventions

- TypeScript everywhere, centralised error handling (`AppError` hierarchy), structured JSON logging, **no swallowed exceptions**.
- Don't use mocks in tests — test real code paths against a real Postgres. Tests refuse to run against a non-`_test` database name.
- Don't add unrequested documentation files or commit `.env`.

## Toolchain gotchas (learned 2026-10-01, Phase 2)

- **The `file_editor` tool can leave a trailing `</content>` or `</text>` line in
  files it creates.** This breaks the build with `TS1110: Type expected` and is
  easily mistaken for a code error. After writing files in bulk, run:
  `grep -rl '</content>\|</text>' --include='*.ts' --include='*.tsx' . | grep -v node_modules`
  and strip them. Always `npx tsc --noEmit` before believing the code is good.
- Prefer `printf` or a heredoc via the terminal for small config files; the editor
  artifact issue hits multi-line creates hardest.
- Vite config uses `reactRouter()` from `@react-router/dev/vite`. The path
  `@shopify/shopify-app-react-router/plugin` **does not exist** in v3 — do not use it.
- `react-router` and `@react-router/*` must be pinned to the **same exact version**
  (7.18.2). Caret ranges produce peer conflicts.
- `@shopify/shopify-api` v12 has **no** `LATEST_API_VERSION` export and **no**
  `future.removeRest` / `future.unstable_persistSession` flags. Only
  `unstable_managedPricingSupport` and `customerAddressDefaultFix` exist.
- `AppSubscriptionLineItemInput`, `appRecurringPricingDetails` and
  `AppSubscriptionLineItemInputConnection` are all real in 2026-07 — verified
  against the live schema, not from memory.
- `ShopPlan.displayName` is **deprecated**; use `publicDisplayName`. Its values are
  a closed set, enumerated in `PLAN_DISPLAY_NAMES` in `app/lib/shopify-rest.server.ts`.
- Prisma enum `PlanStatus` members are exactly: active, cancelled, declined,
  frozen, expired. There is **no** `unknown` member.

## Auth architecture — use the official helpers, do not hand-roll

`@shopify/shopify-app-react-router/server` `shopifyApp()` owns OAuth, session-token
verification, webhook HMAC and CORS. Hand-rolling these is how subtle auth bugs happen.

- **Extension endpoints**: `await authenticate.public.checkout(request)` returns
  `{ sessionToken, cors }`. It throws a 401 `Response` for missing/invalid/expired
  tokens. Shop identity is `sessionToken.dest`, never a body or query field.
  Our own `app/lib/session-token.server.ts` and `app/lib/cors.server.ts` are no longer
  used by the routes — delete them if they become dead.
- **`cors()` wraps a `Response`**, not a data object. Bridge with
  `cors(toResponse(data({...})))` from `app/lib/http.server.ts`.
  The library sets `Access-Control-Allow-Origin: *` for any origin that is not the app URL.
- **Webhooks**: `await authenticate.webhook(request)` verifies HMAC over the raw body
  and returns `{ webhookId, topic, shop, payload, session, apiVersion }`.
  `session` is `undefined` after uninstall — always handle that.
- **React Router v7 removed `json()`**. Only `data`, `redirect` and friends are exported.

## Local Postgres in this container (no Docker, no root)

There is no Docker socket and no root, so `apt-get install postgresql` fails.
Use `embedded-postgres`, which ships real Postgres binaries that run unprivileged:

```
node scripts/dev-postgres.mjs start   # creates sourcetrac + sourcetrac_test on :5432
node scripts/dev-postgres.mjs stop
```

DATABASE_URL for tests: `postgresql://sourcetrac:sourcetrac@localhost:5432/sourcetrac_test?schema=public`

## Schema field names (do not guess — read prisma/schema.prisma)

- `OrderCache` money is `Decimal @db.Decimal(12,2)` with fields `totalPrice`,
  `totalRefunded`, `financialStatus`, `isTest`, `isCancelled`, `createdAtShop`,
  `updatedAtShop` — **not** minor units.
- `SurveyResponse` has `orderTotal Decimal?`, `currency String?`, `isLocked`,
  `reconciled`, `unreconcilable`.
- `WebhookEvent` uses `payloadJson` and an optional `shopId` relation — there is
  **no** `shopDomain` column.
- `BillingUsage` uses `responsesCount` and requires `periodStart` **and** `periodEnd`.
- `Shop.optionsJson` now defaults to `'[]'` so a shop row is valid without merchant setup.
- Prisma `@@unique` creates a unique **index**, not a table constraint. Query
  `pg_indexes` (not `pg_constraint`) when asserting uniqueness in SQL.

## Verified build state (2026-10-01)

`npx tsc --noEmit` clean, `npm run build` clean, `tests/db-invariants.test.ts` 6/6 green
against real Postgres 16.15. Auth is fully delegated to
`authenticate.public.checkout()` / `authenticate.webhook()`; hand-rolled JWT, HMAC
and CORS modules were deleted.
