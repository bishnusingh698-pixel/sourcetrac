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

## Testing gotcha: the Shopify library rejects bots before auth runs

`authenticate.public.checkout()` and the embedded-admin auth call
`respondToBotRequest()` first. If the `User-Agent` matches `isbot`, it throws
**410 Gone** and session-token validation never executes.

`curl` counts as a bot, so `curl localhost:3000/api/responses` returns 410 and
looks like a routing bug. Always send a browser User-Agent when testing auth.

410 = bot-blocked (auth not attempted). 401 = auth actually ran and rejected.
Shopify POS/Mobile agents are exempted and allowed through.

Source: `node_modules/@shopify/shopify-app-react-router/dist/esm/server/authenticate/helpers/reject-bot-request.mjs`

## Checkout extensions: verified 2026-07 APIs

Targets: `purchase.thank-you.block.render` and
`customer-account.order-status.block.render`. API version `2026-07`, packages
`@shopify/ui-extensions@2026.7.4` + `@shopify/ui-extensions-react@2026.0.0`
(the React wrapper has no 2026.7 release).

The two surfaces also have no shared import path: thank-you imports from
`@shopify/ui-extensions-react/checkout`, order status from
`.../customer-account`. Shared code lives in `extensions/shared/src/` and takes
the layout primitives as props.

### The extension↔backend wire contract (check this before renaming anything)

Extensions and routes do not share a type, so nothing but discipline keeps them
aligned. Verified fields:

- `SurveyOption` is `{ value, label, emoji }`. **`value` is the channel key**, not
  `id`. The submit route allowlists it against the merchant's options.
- Submit body is `{ orderId, channel, otherText }`. Sending `optionId` 422s.
- Config response is `{ enabled, questionText, options, allowOther, orderId,
  alreadyAnswered }`. `alreadyAnswered` is what makes the two pages mutually
  exclusive — it must hide the block, not just be logged.
- `OTHER_CHANNEL` (`"other"`) must equal `OTHER_CHANNEL_VALUE` in
  `app/lib/settings.ts`.
- Submit returns `{ ok, counted }` for **both** a fresh write and a duplicate,
  because a buyer who answered always sees confirmation. There is no
  `stored`/`locked`/`duplicate` flag on the wire; `counted: false` is the
  over-cap signal and only the merchant is prompted.

`api.survey-config.tsx` and `api.responses.tsx` are the reference for this.

Things that changed and will bite if written from memory:

- `sessionToken()` is gone. It is now the `useSessionToken()` hook, and it
  returns a `SessionToken` **object** with an async `.get()` that caches and
  re-mints on expiry. Calling `.get()` per request is the documented pattern,
  and it is what makes cold-start retries safe: a token captured before a 60s
  retry would otherwise be stale.
- The order id on the thank-you page is **not** in `useSettings()`. Use
  `useApi<"purchase.thank-you.block.render">().orderConfirmation.value.order.id`.
  Order status uses `api.order.value?.id`.
- `useSettings<T>()` returns `Partial<T>` over `ExtensionSettings`, whose values
  are `string | number | boolean` — it is for merchant preferences, not order
  identity.
- `Box` no longer exists; `View` is the container.
- Translation is `useTranslate()`, not an `i18n` object.
- `network_access = true` is required in `shopify.extension.toml`, plus
  `allowed_urls` naming the exact backend host. Without it the extension cannot
  call `fetch` and the survey silently never loads.
- The backend must return `Access-Control-Allow-Origin: *`.

### The React 18/19 types split

`@remote-ui/react` pins `@types/react` to `>=17 <19`; the admin app uses React 19.
So `BlockStack` and friends resolve to two incompatible `ComponentClass`
identities and fail on `contextType`. `extensions/shared/src/SurveyView.tsx`
takes injected components typed as `Primitive = any` to sidestep it. Do not
"fix" this to `React.ComponentType` — it reintroduces the error.

The two surfaces also have no shared import path: thank-you imports from
`@shopify/ui-extensions-react/checkout`, order status from
`.../customer-account`. Shared code lives in `extensions/shared/src/` and takes
the layout primitives as props.

### Hand-authored extension configs

Shopify's generator could not run here (device auth expired), so the TOMLs are
written by hand. `npm run check:extensions` guards against the mistakes that
actually happened: malformed UUIDs, wrong target, missing `network_access`, and a
`module` path that does not exist.

`npm run typecheck:extensions` typechecks extensions separately — they are not
covered by the root `tsc --noEmit`.

## Money invariants

`orderTotal` is stored in **major** decimal units (e.g. `19.99`), not minor
units. Anything converting to minor units must divide by `10 ** decimals`,
never multiply. This bit the CSV export once already.

`minorUnitDigits` covers zero-decimal (JPY) *and* three-decimal (KWD) currencies.
Three-decimal matters: without it a KWD order total of `1.234` is rejected as
over-precise and that order's revenue is silently dropped.

Refunds only reduce revenue once Shopify reports `financialStatus` as
`partially_refunded`. Before that flip the refund amount is ignored, because the
refund may still be in dispute.

Revenue is never summed across currencies. `rollupByCurrency` and
`sumByCurrency` exist specifically so no caller can flatten them into one number.

## Settings validation gotchas

`validateSurveySettings` reports the question field as `questionText`, matching
what the Settings form reads from `error.fields.field`. An earlier snake_case
key meant the question error never rendered inline.

Duplicate-option detection must compare the raw slug. Calling
`slugifyChannel(label, taken)` first salts the collision, so the subsequent
`taken.has(value)` check could never fire and "Instagram" / "instagram"
silently became two channels with split revenue.

## Tests

`npm test` includes `tests/db-invariants.test.ts`, which **refuses to run**
unless `DATABASE_URL` names a `*_test` database — it calls `reset()` and would
wipe real data. Run non-DB tests with:

    npx vitest run --exclude 'tests/db-invariants.test.ts'

The integration test in `tests/integration/` drives the real `createSurveyApi`
with only `fetch` stubbed, and uses fake timers so the 60s cold-start budget is
tested in milliseconds.
