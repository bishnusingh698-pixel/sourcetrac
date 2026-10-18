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
- **Scopes are `read_orders,write_orders,write_customers,read_products`** (Phase 7 sync). `read_orders` alone serves the survey; the write scopes are gated at runtime on what the merchant granted. `write_customers` puts the app in protected customer data review. No `read_all_orders`.
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

- **AGENTS.md contained real mojibake, not a terminal rendering artefact.**
  Every em-dash had been written as the 5-character run `čéąÉąż`, arrows as
  `čéą¢ąó`, ellipses as `čéąÉąČ`, and the "extension↔backend" heading as
  `čéą¢ąż` — 44 occurrences in total. An earlier pass dismissed this as a
  display artefact because the file parsed as UTF-8; it did not, the bytes were
  simply valid *wrong* characters. Do not re-raise that dismissal.
  Detect it by scanning for runs of ≥3 consecutive non-ASCII characters rather
  than by eyeballing the terminal — CJK strings and box-drawing art are also
  non-ASCII and are legitimate, so match the specific tokens, not the class.
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
- `@shopify/shopify-api` (v15 installed; true since v12) has **no** `LATEST_API_VERSION` export and **no**
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
node scripts/dev-postgres.mjs start --hold   # creates sourcetrac + sourcetrac_test on :5432
node scripts/dev-postgres.mjs stop
```

`--hold` is **required**. Without it the process exits, and the child postgres
is killed with it, so the next command finds nothing listening on 5432.

Run it detached (`setsid ... < /dev/null &`) so it survives the invoking shell —
`nohup` alone is not enough here.

If it still refuses to start with a bare `EBADF`, the cause is IPv6, not the
schema: this container has no IPv6 loopback, postgres tries to bind `::1`, and
exits. The script now passes `postgresFlags: ["-c", "listen_addresses=127.0.0.1"]`.
A stale `/tmp/sourcetrac-pg` from a killed run also causes a confusing
`directory exists but is not empty` — `rm -rf` it.

DATABASE_URL for tests: `postgresql://sourcetrac:sourcetrac@localhost:5432/sourcetrac_test?schema=public`

## Schema field names (do not guess — read prisma/schema.prisma)

- `OrderCache` money is `Decimal? @db.Decimal(18,3)` (`totalPrice`) with fields
  `orderNumber`, `financialStatus`, `isTest`, `isCancelled`, `createdAtShop`,
  `updatedAtShop` — **not** minor units.
- `SurveyResponse` has `orderTotal Decimal?`, `currency String?`, `isLocked`,
  `reconciled`, `unreconcilable`.
- `WebhookEvent` uses `payloadJson` and an optional `shopId` relation — there is
  **no** `shopDomain` column.
- `BillingUsage` uses `responsesCount` and requires `periodStart` **and** `periodEnd`.
- `Shop.optionsJson` now defaults to `'[]'` so a shop row is valid without merchant setup.
- Prisma `@@unique` creates a unique **index**, not a table constraint. Query
  `pg_indexes` (not `pg_constraint`) when asserting uniqueness in SQL.

## Verified build state (2026-10-02)

`npm run typecheck`, `typecheck:extensions` and `npm run build` clean.
`npx vitest run` is **193 passed across 10 files**, including
`tests/db-invariants.test.ts` (15) against real Postgres 16.15. Auth is fully
delegated to `authenticate.public.checkout()` / `authenticate.webhook()`;
hand-rolled JWT, HMAC and CORS modules were deleted.

### Starting the test database

`node scripts/dev-postgres.mjs start` **exits after creating the databases**, which
takes the spawned postgres down with it — the child dies with the parent, so the
next command finds the port closed. It must be started detached:

    setsid nohup node scripts/dev-postgres.mjs start --hold > /tmp/pg.log 2>&1 < /dev/null & disown

Two follow-on traps: `stop` leaves `/tmp/sourcetrac-pg` behind, and a plain
`start` then fails with `directory exists but is not empty` — remove the directory
before initialising. The suite also needs `npx prisma migrate deploy` against
`sourcetrac_test` on a fresh instance, and the full `~/lib/env` schema, or every
test file fails at import with `Invalid environment configuration`.

### A green test run is not evidence on its own

Each of these was confirmed to **fail** when its fix was reverted, so they are
regression tests rather than assertions that merely pass:

- `orderId` money guard — reverting `if (!totalParsed.ok) return 0;` in
  `upsertOrderCache` fails with `expected 0 to be null`: the answer gets stamped
  with a fabricated `$0.00` order total and silently stops counting as revenue.
- `resources: RESOURCES` in `createI18n` — removing it renders the admin keys
  literally (`nav.dashboard`). The failure is silent, so it needs this test.
- `if (!orderId) return;` in `use-survey.ts` — removing it fires
  `?orderId=`, a request the route 422s permanently.
- The dashboard query — dropping its `shopId` filter, or turning its `LEFT JOIN`
  into an inner join, both fail. An inner join hides every unreconciled answer.

DB tests must call the production function (`fetchResponsesInWindow`,
`processWebhook`), never a copy of its SQL: an earlier version asserted against
duplicated SQL and would have passed while production was broken.

`orderIdSchema` lives in `app/lib/settings.ts` and is shared by both extension
routes. That sharing is deliberate — the routes and `orders/create` must agree on
the id format, and `tests/unit/order-id.test.ts` fails if a route goes back to
inlining its own regex. The ui-extensions type is only `id: string`, so **the
type system cannot catch a GID/numeric mismatch**. The webhook stores the
numeric `String(order.id)`; the extensions send GIDs, which the schema
normalises (see "Checkout extensions" below).

React 19 hoists a nested `<html lang={…} />` into correct document order, so
`DocumentLanguage` in `root.tsx` is not a rendering mistake — verified with
`renderToStaticMarkup`.

## App Bridge mounting and the silent blank panel

App Bridge is what renders this app into the Shopify admin iframe. Without it,
every loader still succeeds, `npm run check` stays green, and `/healthz` still
returns 200 — the merchant just sees an empty panel. Nothing at runtime catches
this, so `tests/unit/app-bridge-wiring.test.ts` asserts the wiring against the
source instead.

- `AppProvider` comes from **`@shopify/shopify-app-react-router/react`**.
  `@shopify/app-bridge-react` v4 does **not** export it.
- `AppProvider` injects the Polaris web-components script itself. Do **not** add
  a manual `polaris.js` `<script>` in `root.tsx`; it loads the bundle twice.
- `optimizeDeps.include` is a hard require at dev-server start. Never name a
  package there that is not installed — it fails to resolve and takes the dev
  server down.

### `process.env` in a component is a runtime crash

`process.env` does not exist in the browser, and **Vite does not replace it** —
the expression survives verbatim into `build/client`. Read it in a loader only,
never in a component.

This bit the error boundary: it read `process.env.SHOPIFY_API_KEY` directly, so
on any child-route failure the boundary threw a second time and the merchant got
React Router's default page — the exact symptom the boundary existed to prevent.

The key now lives in the **root** loader and is read back with
`useRouteLoaderData`. The shell's own loader cannot be the source, because a
boundary renders precisely when that loader has failed. The root import is
`import type` only, so the shell never pulls its parent into its own graph.

To verify: `grep -o "process\.env\.[A-Z_]*" build/client/assets/*.js` must be
empty.

## Testing gotcha: the Shopify library rejects bots before auth runs

`authenticate.public.checkout()` and the embedded-admin auth call
`respondToBotRequest()` first. If the `User-Agent` matches `isbot`, it throws
**410 Gone** and session-token validation never executes.

`curl` counts as a bot, so `curl localhost:3000/api/responses` returns 410 and
looks like a routing bug. Always send a browser User-Agent when testing auth.

410 = bot-blocked (auth not attempted). 401 = auth actually ran and rejected.
Shopify POS/Mobile agents are exempted and allowed through.

Source: `node_modules/@shopify/shopify-app-react-router/dist/esm/server/authenticate/helpers/reject-bot-request.mjs`

## Checkout extensions: Preact on api_version 2026-07 (rewritten 2026-10-11)

Targets: `purchase.thank-you.block.render` and
`customer-account.order-status.block.render`, both `api_version = "2026-07"`.

**The block rendered nothing, anywhere, until 2026-10-11.** Two independent
causes, both invisible to every type check and test at the time:

1. **The npm package and `api_version` are NOT independent.** An earlier note
   here said they were. For `api_version` 2025-10 or later, Shopify CLI 4.8
   generates the entry `import T from './src/X.tsx'; shopify.extend(target,
   (...args) => T(...args))`, i.e. it calls the default export as a plain
   function on the new remote-dom runtime. The code exported a React component
   for the old `@shopify/ui-extensions-react` 2025.7 (remote-ui) binding, which
   needs `reactExtension(...)` registration. Read it yourself in
   `node_modules/@shopify/cli/dist/chunk-*.js` (`getBundleExtensionStdinContent`).
2. **React 19 crashes the remote-ui renderer.** `@remote-ui/react` 5 uses
   `react-reconciler` 0.29, which reads React 18's
   `__SECRET_INTERNALS_...ReactCurrentOwner` at render and throws on React
   19.3. The extensions bundle the root's only React (the admin's 19).
   `legacy-peer-deps=true` in `.npmrc` suppressed the `react <19` peer error.

**What the extensions are now:** `@shopify/ui-extensions` 2026.7.4 with
`preact` 10 and `@preact/signals`, Polaris web components (`s-stack`,
`s-clickable`, `s-text-field`, ...), no React. Each block:

- `import "@shopify/ui-extensions/preact"` first. It calls
  `shopify.setSignals(Signal)`, which is what lets Preact re-render when a host
  signal (`orderConfirmation`, `order`) changes.
- `export default async function extension() { render(<Block />, document.body) }`.
- Reads the API from the `shopify` global, typed with
  `import type { Api } from "@shopify/ui-extensions/<target>"`.
- `/** @jsxImportSource preact */` at the top of every `.tsx`: the CLI's esbuild
  uses `jsx: "automatic"`, which otherwise imports `react/jsx-runtime`.
  `tsconfig.extension.json` (and `extensions/tsconfig.json`) set
  `jsxImportSource: "preact"`; the root `tsconfig.json` excludes `extensions/`.
- Component props are fully typed (a bad prop fails `typecheck:extensions`).
  Events are `onClick` / `onInput` / `onChange`.

**`tests/integration/extension-bundle.test.ts` is the guard.** It builds each
block with the CLI's exact entry and esbuild options and runs the bundle in
happy-dom against a fake `shopify` host: the survey must render after the order
signal resolves, a tap must POST, the editor must show the preview with no
requests, and the bundle must contain no React. `check:extensions` also rejects
any import of the old binding. Its fake host's `setSignals` builds signals from
the class the extension passes; a host that ignores it never re-renders.

### Build dependency invariant (do not "fix" by moving packages)
Render omits devDependencies, but the build needs several of them. `.npmrc` sets
`include=dev` to keep them. `npm run check:build-deps` fails if `.npmrc` loses
that line or if a build config imports an undeclared package.

`prisma` is the exception and must stay in `dependencies`: it is a
*peerDependency* of `@prisma/client`, so nothing else provides its CLI, and
`prisma generate` is what makes `@prisma/client` importable at build time.
Moving `vite` / `vite-tsconfig-paths` into `dependencies` to chase a build error
is the wrong fix and bloats the runtime image.

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

Things that will bite if written from memory:

- The order id is a **GID**, not the numeric id: thank-you's
  `shopify.orderConfirmation.value.order.id` is
  `gid://shopify/OrderIdentity/<n>`, order status's `shopify.order.value.id`
  is `gid://shopify/Order/<n>`. `orderIdSchema` strips both to the numeric id
  `orders/create` stores. Do not make it reject GIDs, and do not store them raw.
- **Inside the checkout editor there is no real order.** Both blocks check
  `shopify.extension.editor` and render `SurveyPreview` (sample answers, nothing
  wired to submit) instead of returning null.
- The id arrives asynchronously, so blocks call `useSurvey(orderId ?? "", ...)`
  and `useSurvey` early-returns on an empty id; otherwise every load fires
  `?orderId=`, which the route rejects.
- `shopify.sessionToken.get()` re-mints an expired token; call it per request,
  which keeps cold-start retries valid.
- `network_access = true` is required in `shopify.extension.toml`.
  `allowed_urls` is not part of Shopify's schema (see the 2026-10-07 section).
- The backend must return `Access-Control-Allow-Origin: *`.

### Hand-authored extension configs

Shopify's generator could not run here (device auth expired), so the TOMLs are
written by hand. `npm run check:extensions` guards against the mistakes that
actually happened: malformed UUIDs, wrong target, missing `network_access`, a
`module` path that does not exist, and the old React binding.

`npm run typecheck:extensions` typechecks extensions separately — they are not
covered by the root `tsc --noEmit`.

## Money invariants

`orderTotal` is stored in **major** decimal units (e.g. `19.99`), not minor
units. Anything converting to minor units must divide by `10 ** decimals`,
never multiply. This bit the CSV export once already.

`minorUnitDigits` covers zero-decimal (JPY) *and* three-decimal (KWD) currencies.
Three-decimal matters: without it a KWD order total of `1.234` is rejected as
over-precise and that order's revenue is silently dropped.

### Three-decimal currencies need the column widened too

`parseMoneyToMinor` / `minorToDecimalString` were correct all along for JPY and
KWD. A real audit claim that they "rejected zero-decimal currencies" was
**disproven** — do not re-raise it. `JPY "5000"` -> minor `5000` is correct.

The actual precision loss was downstream, in two places:

- **Column type.** `Decimal(12,2)` rounds on *insert*, so a KWD order of `1.234`
  was already `1.23` in the database. Formatting fixes cannot recover it. The
  money columns are now `Decimal(12,3)` (migration
  `20261001163000_money_decimal_precision`). Widening the type preserves stored
  values, so no data conversion was needed.
- **Export formatting.** A hardcoded `.toFixed(2)` emitted `1.23` for KWD and
  `5000.00` for JPY. Use `formatDecimalForCurrency(value, currency)`, which
  reads precision from `minorUnitDigits`. It accepts Prisma `Decimal`, `string`
  and `number`, and returns `null` for null/empty/unparseable input.

Both the CSV route and the export *preview* use that helper so the preview is
byte-identical to the downloaded file.

Revenue is `current_total_price`, which Shopify already reports net of refunds
and edits, so nothing subtracts a refund (that would deduct it twice).
`refunded` and `voided` statuses, test and cancelled orders are excluded in
`evaluateRevenue`.

### Never reconcile from an unparsed total

`OrderCache.totalPrice` is **nullable**. `upsertOrderCache` stores NULL for a
total `parseMoneyToMinor` rejects (and never overwrites a good stored total with
NULL), and skips reconciliation. `reconcileFromOrderCache` (answer arriving after
the order) returns early on a NULL total. The answer stays "Pending" rather than
reading as a real $0.00 order. An older note here described a `"0.00"` fallback;
that design is gone.

## A React Router ErrorBoundary cannot fix CORS

The original audit finding "the API routes throw errors without CORS headers" is
real but the suggested fix is impossible. A thrown error is serialised by React
Router itself, and the route's `ErrorBoundary` cannot set
`Access-Control-Allow-Origin` on that response. The extension would then read a
genuine 400 as an opaque network failure and retry it.

The fix is `try { ... } catch { return cors(toResponse(body, { status })) }`
around the body of each API action/loader, **after**
`authenticate.public.checkout()`. The auth call stays outside the try: its 401
already carries the library's own CORS headers. `serialiseError` logs once and
returns a body with no stack or SQL detail.

## Extension api identity must not drive fetches

`createSurveyApi(...)` was called inline in both block components, so its
identity changed on every render, and `useSurvey` listed `api` in its effect
dependencies. Every re-render refetched the config, burned a
`BUCKETS.surveyConfig` token and hit the database.

Fixed on both sides: `useMemo` in `ThankYouBlock.tsx` and
`OrderStatusBlock.tsx`, and an `apiRef` in `use-survey.ts` so the effect keys
on `[orderId, surface]` alone. Changing either without the other leaves the
storm in place.

## Analytics: AOV denominators and per-day counting

Two real bugs, both with regression tests in `tests/unit/analytics.test.ts`:

- **AOV** divided total revenue by the *response* count, so pending
  (no-revenue) responses and multi-currency shops both skewed it. It now
  divides by the count of actual decided revenue-contributing orders, per
  currency. `Summary` carries `revenueOrdersByCurrency`.
- **Trend** collapsed each UTC day to its first response, so a day with seven
  answers plotted as one. Every response on a day is now counted.

## Dashboard copy must not contradict the numbers

The at-cap banners said locked answers were "paused from your dashboard totals"
and would "appear as soon as you upgrade". They were never excluded from
`computeStats` — only flagged `isLocked` for the upgrade prompt. AGENTS.md is
explicit: *never hide the merchant's own data to create urgency*. So the copy
was wrong, not the totals, and the copy was corrected in `app.tsx` and
`app._index.tsx`. Do not "fix" this by excluding locked rows from analytics.

Revenue is never summed across currencies. `rollupByCurrency` and
`sumByCurrency` exist specifically so no caller can flatten them into one number.

## Admin i18n gotchas

**`createInstance().init()` MUST receive `resources`.** Omitting it is silent:
the instance initialises cleanly, `t()` returns its own key as a string, and
every translated string in the admin renders as `nav.dashboard` instead of
"Dashboard". There is no error and no warning — this shipped once with all ten
locale files committed and correctly populated. `tests/unit/i18n.test.ts` now
asserts a known key resolves to real prose, which is the only thing that
catches it.

**A plural key does not resolve without `count`.** Keys stored as
`key_one` / `key_other` need `{ count: n }` passed, or `t()` returns the
unsuffixed key untranslated — the same raw-key symptom as a missing `resources`,
so the two are easy to confuse. All current plural forms are identical across
languages (the counts are digits, so no locale needs a different form), but
`count` must still be passed for the lookup to happen.

`getFixedT` works synchronously only because resources are bundled. Do not
switch to a lazy backend loader without re-checking every caller.

## Settings validation gotchas

`validateSurveySettings` reports the question field as `questionText`, matching
what the Settings form reads from `error.fields.field`. An earlier snake_case
key meant the question error never rendered inline.

Duplicate-option detection must compare the raw slug. Calling
`slugifyChannel(label, taken)` first salts the collision, so the subsequent
`taken.has(value)` check could never fire and "Instagram" / "instagram"
silently became two channels with split revenue.

## Polaris theming rules for the embedded admin

Merchants can theme the embedded admin. Anything that hardcodes a colour fights
that, so the dashboard follows these rules:

- **No hex, `rgb()`, or `hsl()` anywhere.** Not in a `style` attribute, not in
  the SVG. Verify with
  `git diff -U0 app/ | grep "^+" | grep -iE "#[0-9a-f]{3,8}|rgb\(|hsl\("`.
- **These elements do not accept `style` at all.** Layout must come from their
  documented attributes (`padding`, `gap`, `gridTemplateColumns`,
  `background`, `border`, …). `admin-ui.tsx` says so at the top; a stray
  `style=` there is silently ignored rather than applied.
- **Themeable colour comes from tokens**: `s-badge tone`, `s-progress tone`,
  `s-box background`, `s-text color`, `s-divider color`. Prefer these over
  hand-rolled markup.
- **In hand-rolled SVG, use `currentColor`** with an `opacity` attribute for
  the faded variants (`fillOpacity`, `strokeOpacity`). `currentColor` inherits
  whatever the theme sets, so the chart stays legible on both light and dark.
- **Money and metric numbers get `fontVariantNumeric="tabular-nums"`** so
  columns align and digits do not jitter as they change.

Two tone sets, and mixing them is a type error on purpose:
`Tone` = `info | success | warning | critical` for `s-banner`;
`BadgeTone` = `neutral | Tone` for `s-badge` / `s-progress`, which also accept
`neutral`. Declaring `neutral` on a `Banner` must not compile.

### Attribute values must be read from the installed types, not guessed

`node_modules/@shopify/polaris-types/dist/custom-elements.json` is the source of
truth. It is nested as `modules[].declarations[]` with `kind: "class"` — there is
no top-level `elements` array, and no `type`-kind declarations, so
`MaybeAllValuesShorthandProperty<BoxBorderRadii>` has to be resolved from
`dist/polaris.d.ts` instead. Guessing cost two wrong attributes in one pass:
`size="small"` on `s-badge` (valid values are `base | large | large-100`) and
`neutral` on a banner tone.

`noUncheckedIndexedAccess` is on. `points[0]`, `amounts[0]` and
`points[points.length - 1]` are all possibly-undefined, which matters because an
empty trend array has no peak. Destructure (`const [only] = amounts`), use
`.at(-1)`, or seed a `reduce` with `undefined` and narrow.

## Dashboard chart invariants

- **Share bars are relative to the busiest channel**, not to 100%. A flat
  distribution (40/30/30) should read as three comparable bars, not three
  unrelated slivers.
- **`responseRateChange` null means "no comparable previous period"**, not zero.
  Render no badge at all rather than `0%`, which would be a fabricated
  measurement.
- **A metric's value must never be conditional** — only its badge is. Making the
  number itself appear/disappear resizes the tile and jumps the whole row.
- **`YYYY-MM-DD` is formatted from its string parts**, never `new Date(key)`,
  which parses as UTC midnight and renders as the previous day at negative UTC
  offsets.
- **An empty or single-point trend renders a panel, not a broken line.** The
  "not enough data" copy must never depend on `canDrawLine` being inverted again.

## Tests

`npm test` includes `tests/db-invariants.test.ts`, which **refuses to run**
unless `DATABASE_URL` names a `*_test` database — it calls `reset()` and would
wipe real data. Run non-DB tests with:

    npx vitest run --exclude 'tests/db-invariants.test.ts'

The integration test in `tests/integration/` drives the real `createSurveyApi`
with only `fetch` stubbed, and uses fake timers so the 60s cold-start budget is
tested in milliseconds.

## Decimal column scale corrupts the money text form (found 2026-10-02)

The `Decimal(12,3)` widening described above is **load-bearing in a way that is
easy to undo**. Postgres renders a `numeric` at its *declared* scale, so every
stored amount comes back through the `::text` cast padded to 3 places - a USD
total reads as `"42.500"`, JPY `"5000.000"`.

`parseMoneyToMinor` therefore compares only the *significant* digits
(`fraction.replace(/0+$/, "")`) against `minorUnitDigits`, and the padded minor
units must be derived from that same trimmed string. Two mistakes were made and
caught while fixing this, and neither is visible to the type system:

- Counting the untrimmed length rejects `"42.500"` as over-precise, so
  `evaluateRevenue` excludes **every** two-decimal order as `unparseable_total`.
  No currency's revenue counts at all.
- Padding from the untrimmed fraction inflates by 10x (`"42.500"` becomes 42500
  minor units instead of 4250).

The pattern is `^-?\d+(\.\d+)?$`, not `\d*`: the old `\d*` accepted `""`, `"   "`
and `"-"`, which fell through to a clean `0` and read as a real $0.00 order.

Tests in `tests/unit/revenue.test.ts` and `tests/db-invariants.test.ts` cover all
three decimal widths. Do not "simplify" the trailing-zero trim away.

## `hasOrder` must key on NOT NULL columns, not `financialStatus`

`toResponseWithOrder` detects a `LEFT JOIN` miss. `OrderCache.financialStatus` is
**nullable** and Shopify leaves it null while an order is unpaid or
authorized-but-pending, so requiring it non-null collapsed real orders to
`order: null` and dropped their revenue. Only the NOT NULL columns
(`totalPrice`, `createdAtShop`, ...) may signal a missing row.

## Webhook retries: key the re-claim on `error`, not on `processedAt`

`claimWebhook` is insert-first. A unique violation means the id is already in the
ledger and the delivery is refused - correct for a *completed* one. But a delivery
that **threw** would also be refused, so the route returns 200, Shopify stops
retrying, and one transient DB fault permanently loses that order.

`markWebhookFailed` is what distinguishes "we tried this and it broke" from "we
are still working on it", so the re-claim condition is
`existing.error && !existing.processedAt`. Keying on `!processedAt` alone would
also re-claim an **in-flight** delivery and run the handler twice in parallel,
which is the single case insert-first exists to prevent. All three cases are
tested in `tests/db-invariants.test.ts`.

## Plan reconciliation can un-cancel a subscription - unfixed on purpose

`app/routes/app.plans.tsx` maps `paidPlanFromSubscriptions(...) ?? "free"` into
`setPlan(..., { planStatus: "active" })`. That function returns `null` for both
"genuinely on free" and "a subscription we do not recognise" (it requires
`name.startsWith("sourcetrac")` and `status === "ACTIVE"`), so a merchant whose
status reads anything unexpected is downgraded, and a cancelled merchant gets
`planStatus` forced back to `active`. Left unfixed: whether a transient Shopify
read failure should downgrade a paying merchant is a billing-policy decision, not
a bug fix. Tracked in `BUG_FIX_REPORT.md`.

## Local env: `.env` points at the non-test DB

A local `.env` sets `DATABASE_URL` to `sourcetrac`, so a bare `npm run check`
makes `tests/db-invariants.test.ts` refuse to run (its `*_test` guard) and the
suite reports `23 skipped` plus a failed file. That is the guard working, not a
regression. Run the full chain with an explicit override:

    DATABASE_URL="postgresql://sourcetrac:sourcetrac@127.0.0.1:5432/sourcetrac_test?schema=public" npm run check

## Branch layout: `main` only (consolidated 2026-10-02)

There is exactly one branch, `main`, and it is also the GitHub default branch.
The former `sourcetrac-v1`, `feat/i18n-and-ui-polish` and `fix/full-bug-audit`
branches were deleted after `main` was verified to be a strict superset of all
three (the only commits not carried over were a write-access probe that added
then deleted `.probe-write-test.txt`, netting to zero content).

Do not reintroduce long-lived branches here. `main` is unprotected, so treat
every push to it as a release: run `npm run check` first.

Note that `sourcetrac-v1` was the *old* default branch, so any tooling,
webhook config or CI reference still naming it is stale.

## Git push needs a git-write-scoped token, not the sandbox's default one

The sandbox's injected `GITHUB_TOKEN` authenticates fine against the API --
`GET /repos/:owner/:repo` returns 200 and reports `admin: true, push: true` --
but **every** git transport is refused with
`remote: Permission to <owner>/<repo>.git denied`. Verified against three
transports: the remote URL's embedded credential, a `https://<user>:<token>@...`
URL, and `GIT_ASKPASS` with `credential.helper=` and `http.extraheader=` cleared.

A user-supplied fine-grained PAT (`github_pat_...`) **does** push successfully.
Use it via `GIT_ASKPASS`, never embedded in the remote URL, so the credential is
not persisted to `.git/config`:

    printf '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *Password*) echo <TOKEN>; esac\n' > /tmp/ap.sh
    chmod +x /tmp/ap.sh
    GIT_ASKPASS=/tmp/ap.sh GIT_TERMINAL_PROMPT=0 git -c credential.helper= push <url> <branch>
    rm -f /tmp/ap.sh

**Such a token still cannot create a PR.** `POST /pulls` returns
`403 Resource not accessible by personal access token` while `GET /pulls` returns
`200` -- it carries contents/git write but not **Pull requests: write**. Creating
the PR has to be done by a human, or by a token whose fine-grained permissions
include that box.


## Production fixes (2026-10-06)

- **Billing redirect must break out of the iframe.** React Router's plain
  `redirect` to `confirmationUrl` renders Shopify's approval page inside the
  embedded frame, which refuses to load. The library's `redirect(url, { target:
  "_top" })` is no better from an action: for a fetch it throws a 401 with a
  reauthorize header, and that 401 reached the error screen ("401
  Unauthorized", 2026-10-18). The action now returns `confirmationUrl` and the
  page calls `window.open(url, "_top")`, checked by `isShopifyConfirmationUrl`
  (`app/lib/billing-redirect.ts`).
- **Superseded subscription notices are ignored.** A non-active
  `app_subscriptions/update` only applies when its GID matches
  `Shop.subscriptionGid`; otherwise the old plan's late CANCELLED would drop a
  merchant who just upgraded. Test: `tests/db-subscription-supersede.test.ts`.
- **Admin loaders use `ensureShop(session)`**, never `findShopByDomain` + a
  redirect to `/auth`. Parent and child loaders run in parallel, and `/auth`
  without the embedded query string cannot authenticate.
- **Extensions must not read `process.env`** — it does not exist in the Web
  Worker. `API_URL` is a literal; `check:extensions` enforces it.
- **`npm run start` migrates first** via `scripts/migrate.mjs`, which uses
  `DIRECT_URL` or strips `-pooler` from `DATABASE_URL` (PgBouncer transaction
  mode cannot hold Prisma's advisory lock) and retries while Neon wakes.
- **Retention runs itself** at most daily from the webhook route
  (`maybeRunRetention`); `/jobs/retention` remains for external schedulers.
- **Admin loaders/actions are wrapped in `guarded()`** (`app/lib/admin-errors.server.ts`).
  Production sanitises thrown Errors to "Unexpected Server Error", which left
  no clue on screen. `guarded` rethrows a `data({ reference, hint }, 500)`,
  which is not sanitised, and both boundaries render the hint. Redirects and
  `data()` responses pass through untouched.
- **CSV download is a `fetch` + blob**, not a link: inside the admin iframe a
  link carries no session token. The route is `/app/export/csv`, not `.csv`.
- **`Session` needs `refreshToken` / `refreshTokenExpires`.**
  `@shopify/shopify-app-session-storage-prisma` v11 writes both on every
  `storeSession`, so without them every token exchange threw
  `PrismaClientValidationError` and no merchant could open the app. Local
  simulations that pre-seed a session never call `storeSession` and miss
  this; `tests/db-session-storage.test.ts` drives the real storage.

## Translation coverage (fixed 2026-10-06)

The locale files were complete, but Dashboard, Survey (settings), Export, Plans
and Help hardcoded English, so a German merchant saw German navigation around
English pages. Every admin page now translates; `tests/unit/i18n-call-params.test.ts`
fails if a page under `app/routes/app.*.tsx` stops using a translator.

- **Child pages read the shell's language with `useAdminI18n()`**
  (`app/lib/i18n/use-admin-i18n.ts`), via `useRouteLoaderData("routes/app")`.
  Loaders that format money or dates on the server use
  `resolveAdminLanguage(request, shop.language)`; they cannot wait for the shell,
  which loads in parallel. Page titles use `adminTitle(matches, key)` in `meta`.
- **Actions return translation keys, not English.** Settings and Plans return
  `{ key, params }` (`I18nText`), and the component calls `t()`. Validation
  errors carry `fields.i18n`; read it with `validationI18n(error)`.
- **`i18n-usage.test.ts` accepts `foo_one`/`foo_other` as defining `foo`**, which
  is how `shell.cap_warning_body` shipped without `count` and rendered its raw
  key. `i18n-call-params.test.ts` now checks every literal `t()` call passes
  `count` for plural-only keys and every `{{placeholder}}` its string uses.
- **Plan names are translated per locale** ("Kostenlos", "Gratuit", "無料"). New
  strings must use the locale's own name, never "Free"/"Growth"/"Scale".
- **German uses formal "Sie"**; es/it/nl/pt-BR/sv use the informal form.
- **The checkout extensions have their own `locales/`** (`en.default.json` plus
  one file per language) in *both* extension directories. Without them every
  buyer saw English.
- **New shops are seeded with the English survey.** The Survey page offers the
  defaults in the merchant's language (`survey_defaults.*`) while the survey is
  untouched and has no answers. After the first answer, rewording would re-key
  a channel and split its history, so the offer disappears.
- **`slugifyChannel` keeps letters from any script.** The old `[^a-z0-9]` rule
  turned every Chinese/Japanese/Cyrillic label into `"channel"`, so a second
  such option was rejected as a duplicate. Latin slugs are byte-identical to
  before, which the tests pin.
- **The "Other" choice is added by the extension** (`surveyChoices`). The config
  only lists the merchant's options, so before this the "Allow a free-text
  answer" switch had no effect for buyers.
- **Step 1 of onboarding links to the checkout editor**
  (`/settings/checkout/editor`), opened with `target="_top"`. It used to link to
  the Online Store theme editor, where the block cannot be found. The
  `?page=thank-you` parameter could not be verified against shopify.dev (blocked
  from this container); without it the editor still opens.

## Thrown 2xx auth pages must render through `boundary.error` (fixed 2026-10-06)

`authenticate.admin` answers a document request that lacks `host` (billing
return, bookmarked URL, first open after install) by **throwing a 200 HTML
Response** — the App Bridge page that redirects into the admin. React Router
routes that throw to the ErrorBoundary. The shell's custom boundary rendered it
as a failure, so the merchant saw "200 Go to the dashboard" and never reached
the dashboard or the survey editor. Both boundaries now call
`boundary.error(error)` when `isShopifyAuthResponse(error)` (a 2xx
`ErrorResponse`, `app/lib/shopify-boundary.ts`); real failures keep the custom
screen.

**Never call the library's `boundary.error` in a component** (fixed 2026-10-18).
It recognises the error by `constructor.name === "ErrorResponseImpl"`, which
the production client bundle minifies (`qe`), so in the browser it rethrew and
the root boundary showed "200" — the merchant's "random 200 error". Both
boundaries render `ShopifyAuthPage` (`app/components/shopify-auth-page.tsx`):
the server's page hydrates unchanged; on a page switch (a `.data` request that
reached the server without a session token gets the same App Bridge page,
whose scripts never run via `innerHTML`) it reloads the target page with
`shop`/`host`/`embedded` from `shopify.config` or the boot URL, once per 20 s.
`root.tsx` calls `markDocumentHydrated` so later renders count as page switches. Reproduce with a browser UA: `curl -A "Mozilla/5.0 Chrome/130" "localhost:3000/app?shop=x.myshopify.com"`
must return the `app-bridge.js` script tag, not the error text.

- **Billing `returnUrl` is the admin URL**
  (`https://admin.shopify.com/store/<store>/apps/<client_id>/app/plans`), via
  `billingReturnUrl()`. A bare `APP_URL/app/plans` arrives top-level with no
  `shop`/`host`/token and cannot authenticate.
- **`<s-app-nav>`** in `app.tsx` registers the pages in the Shopify admin
  sidebar. It is an App Bridge element, typed locally in `app/types/app-bridge.d.ts`.
- **`APP_URL` falls back to `SHOPIFY_APP_URL`**, which `shopify app dev` exports
  with the per-run tunnel URL.
- Local browser checks: headless Chromium's UA is a bot (410). Stub
  `cdn.shopify.com` and patch `fetch` to add `Authorization: Bearer <id_token>`
  the way App Bridge does, or client-side navigation fails auth.

## Phone layout and hardening pass (2026-10-07)

- **No in-iframe sidebar.** Shopify renders `<s-app-nav>` in its own sidebar on
  desktop and the app title menu on phones; a second copy inside the frame took
  a column and squeezed every page on a phone. The shell is now a compact
  toolbar (plan badge + usage, language select) above the page. (A horizontal
  *top* bar was added 2026-10-15; see "Top navigation bar" below. It is one row,
  not a column, so it does not squeeze the page.)
- **The dashboard is home.** Its `s-link` in `<s-app-nav>` carries `rel="home"`
  (spread, since Polaris's `s-link` type has no `rel`), so it is the app's
  landing page, not a separate "Dashboard" sub-page. The onboarding page was
  deleted: the dashboard shows the setup guide until the first answer exists.
- **Responsive layout comes from `@container` values**, e.g.
  `gridTemplateColumns="@container (inline-size > 760px) repeat(4, …), …"`
  inside `<s-query-container>`. It responds to the iframe's width, not the
  device's. No media queries on `s-*` elements.
- **`s-table` markup:** column headers are `<s-table-header listSlot=…>` inside
  `<s-table-header-row>`. Wrapping the row in `s-table-header` with
  `s-table-cell` headings (the old markup) is wrong and never collapses to the
  list layout on narrow screens.
- **The "Other" text field is uncontrolled and tracked with `onInput`**;
  `onChange` fires on blur only, so a controlled field left Submit disabled
  while the buyer typed with the phone keyboard open.
- **Rate limits have shop-wide backstops** (`responseShop`, `surveyConfigShop`).
  Per-order keys are caller-chosen, so one lifted checkout token plus made-up
  order ids got unlimited fresh buckets. `/api/responses` validates and rate
  limits before touching the DB, and caps the body at 4 KB (`readBodyText`).
  The bucket sweep is throttled; it used to rescan the whole map per request.
- **Test charges never grant a paid plan in production**
  (`paidPlanFromSubscriptions`, `allowTest`).
- **Cancelling / switching to Free asks for confirmation** (`ConfirmCancel` in
  `app.plans.tsx`), using the `plans.cancel_*` keys that already existed.

## Why the survey never appeared (fixed 2026-10-07, second pass)

Found by driving the built server with a signed checkout session token, not by
the unit tests, which stub `fetch` with the shape the extension expects.
`tests/db-extension-routes.test.ts` now calls the real routes that way.

- **`toResponse(data(...))` serialised the wrapper.** Every extension response
  was `{"type":"DataWithResponseInit","data":{...},"init":null}`, so the
  extension read `enabled` as undefined and hid the survey on every order.
  `toResponse` now unwraps `data()` (recognised by shape; its class is not
  exported at runtime) and keeps its status and headers.
- **`/api/responses` had no loader.** React Router sends OPTIONS to the loader,
  so the browser's preflight got a 400 without CORS and no answer could be
  sent. The loader calls `authenticate.public.checkout`, which answers OPTIONS
  with a CORS 204. Any extension route needs both a loader and the auth call.
- **No plan gate in the extension routes.** Shopify only runs the block where the
  plan supports it, so our stored plan reading could only hide the survey
  wrongly. Trial / Plus Trial were classed unsupported, which hid the survey and
  dropped answers on exactly the stores where merchants test.
  `UNSUPPORTED_PLANS` now only drives the admin banner.
- **`allowed_urls` is not in Shopify's extension schema** (checked against the
  CLI's capability schema: network_access, block_progress, api_access,
  collect_buyer_consent, iframe, bundle_size_exception). The CLI ignores it;
  `network_access = true` alone permits fetch.
- Simulating with Node `fetch` returns **410** (bot filter) unless a browser
  `User-Agent` is set, and the session token's `dest` is the bare
  `store.myshopify.com`.

## Full audit pass (2026-10-11)

Each fix has a test that fails on the old code.

- **A merchant option named "Other" lost every answer** when free text was off.
  Its slug is `other`, the free-text channel, and `/api/responses` rejected it
  as a disallowed free-text answer. Only reject `other` when it is not one of
  the merchant's own options (`tests/db-extension-routes.test.ts`).
- **Two options could share a channel key.** Kept options retain their stored
  value, which can differ from their label's slug (the default "Google search"
  is `google`); a new "Google" slugged to `google` too. Kept values are now
  reserved first and new ones suffixed (`tests/unit/settings-csv.test.ts`).
- **Test charges granted paid plans via the webhook** in production;
  `isIgnoredTestCharge` now matches `paidPlanFromSubscriptions`.
- **Plans page vs enforcement.** `needsPlanSync` also re-activates a paid plan
  Shopify reports ACTIVE when our status is `frozen`/stale; before, the page
  showed Growth while the survey enforced the Free cap.
- **Open redirect.** `safeInternalPath` (now in `http.server.ts`) rejects
  backslashes and control characters; `/\evil.com` became `//evil.com`.
- **`P1017` / `P1002` are retryable.** Neon closes pooled connections when it
  suspends; the first query after idle used to fail outright.
- **Retention drops every webhook-ledger row past 30 days**, failed ones too.
  The ledger holds no payload, so an old failed row can never be re-run.

## CSV export and missing orders (2026-10-11)

- **CSV columns are** `order, submitted_at, timezone, channel, other_answer,
  order_total, currency, revenue_status, order_link` (`app/lib/csv.ts`). The bare
  13-digit order id rendered as `6.12346E+12` in spreadsheets; `order` is the
  order name (`#1001`) and the id lives in `order_link`.
- **`submitted_at` is `YYYY-MM-DD HH:mm:ss` in the shop's `ianaTimezone`**,
  fetched per export (`loadExportContext`), falling back to UTC. The `timezone`
  column names the zone actually used. Dashboard buckets stay UTC (rule above).
- **`order_total` is shown whenever the order is known**, test/cancelled/refunded
  included; `revenue_status` (`counted`, `test order`, ...) carries the
  dashboard's decision. Blank total = order not received. The old "blank unless
  counted" rule made every row on a development store blank.
- The file starts with a UTF-8 BOM, or Excel on Windows garbles non-ASCII labels.
- **`backfillMissingOrders`** (`app/lib/order-backfill.server.ts`) fetches orders
  no webhook delivered (placed before install, or during an uninstall gap) via
  GraphQL `order(id:)` and writes them through the webhook's `upsertOrderCache`.
  Runs from the dashboard and export loaders, bounded, never throws.
- `markUnreconcilable` first reconciles answers whose order is already cached
  (`reconcileOrphanedResponses`); the submit-time reconcile is best-effort.
- Response rate: the numerator excludes answers on test/cancelled orders, like
  the denominator. The period badge is the change in answer count, so it sits
  on the Responses tile.
- The "Other" field label must not say "optional": a blank answer is not sent.

## Adversarial audit (2026-10-11, second pass)

- **`authenticate.webhook` returns the topic upper-cased** (`ORDERS_CREATE`, via
  shopify-api's `topicForStorage`). The route passed it straight through, so no
  handler ever matched: no order was cached, uninstall kept the token, billing
  notices and GDPR redactions did nothing, and every test stayed green because
  they called `processWebhook("orders/create")` directly. The route now maps it
  back with `normaliseWebhookTopic` (a lookup, since `app_subscriptions/update`
  keeps its underscore). `tests/db-webhook-route.test.ts` signs real requests
  and drives the route; keep every new topic covered there.
- **`app_subscriptions/update` nests the subscription** under `app_subscription`.
  Uninstall resets the shop to Free; notices for an uninstalled shop are ignored.
- A webhook retry that finds the first delivery still in flight gets **503**, not
  200, so Shopify keeps retrying if that first attempt fails.
- The shop-wide rate-limit backstop never refuses an order in `OrderCache`
  (`consumeShopBackstop`), so made-up order ids cannot lock real buyers out.
  `consumeToken` re-inserts keys so eviction drops idle keys, not the backstops.
- Money columns are `Decimal(18,3)`; `parseMoneyToMinor` rejects more than 15
  integer digits. `expired` is excluded like `voided`. An update never clears
  `isCancelled`. The cap lock is re-decided from the atomic usage increment.
- `Session.accessToken` / `refreshToken` are AES-GCM sealed (`enc:v1:` prefix) by
  the wrapper in `session-storage.server.ts`; plain legacy rows still load.
- `/readyz` needs `x-retention-secret`; open, it let anyone keep Neon awake.

- Optional env vars treat `""` as unset (`parseEnv`). `assertStartupInvariants`
  now runs at boot. Node `>=22.12.0`. `shopify.web.toml` exists so
  `shopify app dev` starts the backend.
- `Shop.adminLocale` remembers Shopify's `?locale=` from the first document load.
- Settings form fields are `label.<i>` / `emoji.<i>` (`readIndexedOptions`).
- Known and left: `npm audit` still lists dev-only advisories (vitest/tinypool,
  the Shopify CLI's global-agent, `@shopify/ui-extensions`' build-time ts-morph,
  prisma CLI's deepmerge-ts). The suggested fixes are downgrades or major bumps
  of build tooling; none of it ships in the runtime bundle.

## Multi-question survey (Phase 2/3, 2026-10-12)

The plan lives in `AUDIT_AND_PLAN.md` (the "survey-app-upgrade-plan.md" the user
names). Phases 1–3 are done: shared rules, the new tables + lossless backfill,
and the survey list/editor. Phases 4+ are still pending, so nothing here should
be treated as shipped.

### The migration is additive on purpose
`20261012095226_multi_question_survey` creates `Survey` / `Question` / `Option`
/ `Response` / `Answer` / `SurveyDailyStats` / `PendingSync` / `PendingDeletion`
/ `DataRequest` and **drops nothing** — `SurveyResponse` and the old `Shop`
survey columns stay for this release. The backfill is a PL/pgSQL `DO $backfill$`
block at the end of the migration (not a separate step): one Survey + one
`single_choice` Question per Shop, option `value`s kept verbatim, every old
`SurveyResponse` turned into a `Response` + one `Answer`. It re-derives the
revenue decision with the same rule as `evaluateResponseRevenue`, so a
reconciled answer on a countable order contributes and everything else counts
responses only. `tests/db-migration-backfill.test.ts` extracts and runs that
exact block — never a copy — so the test tracks the shipped SQL.

### Show-if must accept the fixed option ids
`resolveOptions` returns only the **merchant's** options, so a show-if condition
on a `yes_no` or `satisfaction_5` question — whose ids are the stable `yes`/`no`
and `very_dissatisfied`…`very_satisfied` — had nothing to match against and
every such condition failed as `show_if_option_unknown`. Two of the twelve
shipped templates (`did-you-compare`, `first-time-vs-returning`) could not be
saved. `showIfOptionIds(question)` in `shared/survey-rules.ts` is now the single
source: merchant options (archived included) for merchant types, `fixedOptions`
otherwise. The editor's `showIfOptions` mirrors it, and the question picker only
offers earlier choice/score questions — a text question can never form a valid
condition. `tests/unit/survey-rules.test.ts` pins all three cases (Yes/No
accepted, satisfaction accepted, an unknown id still rejected).

### The suite must run serially — the DB tests share one Postgres
Twelve `tests/db-*.test.ts` files truncate the same database in `beforeEach`, so
with file-level parallelism one file wipes another's rows mid-test. The symptom
is a **flaky** `23503` foreign-key or a phantom retention/backfill failure that
passes when the file is run alone. `npm test` is therefore
`vitest run --no-file-parallelism` (12s, 588 green, deterministic). Vitest's
per-project `fileParallelism: false` did **not** reliably serialize the DB
files here, so do not switch back to a projects config for this. If a DB test
fails while the file passes in isolation, suspect the shared database first, not
the code.

## Phase 7 — Shopify sync: scope gating and the Flow wire contract

`shopify.app.toml` now requests `read_orders,write_orders,write_customers,
read_products`. The danger is not a crash: a sync code path that *assumes* a
scope and fires a GraphQL write anyway, so Shopify rejects it on a store whose
merchant has not re-approved the new scopes.

- Every Phase 7 write checks `canSync(session.scope, "<scope>", shopId)`
  (`app/lib/scopes.server.ts`) and **skips, without throwing**, when the scope is
  absent. The survey keeps collecting and reporting; only the tag/metafield sync
  is dropped.
- `hasScope` splits on commas. It must **not** be a plain `includes`: `read_orders`
  contains the substring `orders`, and a naive match would grant the wrong scope.
  `tests/unit/scopes.test.ts` pins `read_orders` does not satisfy `write_orders`.
- `assertStartupInvariants` (`app/lib/env.ts`) has a deliberate allowlist of the
  four scopes; a fifth fails the check on purpose (App Store requirement 3.2).
- The admin block extensions call our own backend. Auth is an App Bridge
  **ID token** (`Authorization: Bearer`), verified in `app/lib/id-token.server.ts`;
  the shop is the token's `dest` claim, never a body field. `tests/db-admin-
  survey-context.test.ts` drives a signed token and asserts the body's shop is
  ignored (a wrong-secret token gets 401, still with CORS).
- The customer block resolves the answer by reading the customer's **orders**
  (`orders(query: "customer_id:…")`) rather than the `customer` query, so it
  needs only `read_orders` and never `read_customers`.
- `tests/integration/extension-bundle.test.ts` now also builds both admin blocks
  with the CLI's exact entry and runs them against a fake admin host: the POST
  must carry the ID token, the numeric id, and no React in the bundle.

### The Flow trigger payload is a silent contract

`flowTriggerReceive` **ignores** a payload whose keys do not match the trigger's
declared fields: no error, no workflow run. The fields live in
`extensions/sourcetrac-flow-trigger/shopify.extension.toml`; the payload is built
in `app/lib/sync.server.ts`. `tests/unit/flow-trigger-contract.test.ts` reads the
TOML and asserts every declared key (including the spaced `"Channel label"`) and
the handle appear verbatim in the sync source. Rename either side and that test,
not a merchant's flow, is what breaks.

## Phase 8 — Privacy covers the new tables

- `customers/redact` deletes the v2 `Response` rows too. Answers cascade with
  their Response, but `PendingSync` holds only a plain `responseId`, so it is
  removed explicitly or it would be orphaned.
- A redact naming more orders than `REDACT_BATCH_SIZE` (200) is **deferred**: the
  first batch runs inline so the webhook stays under Shopify's 5-second budget,
  and the **remainder only** is stored in `PendingDeletion` (storing the whole
  set makes the lazy drain re-delete the first batch). `processPendingDeletions`
  drains a few batches at a time when the merchant opens the dashboard
  (`maybeRunPendingDeletions` in the home loader).
- `customers/data_request` now persists a `DataRequest` row (the summary the
  Settings page shows for 30 days), never the buyer's email.
- Retention ages out the new tables: `DataRequest` on the 30-day webhook clock,
  `PendingDeletion` on the 24-month record clock. The `RetentionReport` grew
  `dataRequestsDeleted` and `pendingDeletionsDeleted`.

## Audit pass (2026-10-12) — logic, security, completeness

Four artifacts are the map of this pass: `LOGIC_MAP.md` (Mermaid flows),
`COMPLIANCE_MATRIX.md` (every plan/billing requirement with evidence),
`AUDIT_REPORT.md` (findings) and `CHANGES_SUMMARY.md` (audit section). Where the
referenced `survey-app-upgrade-plan.md` and the code disagree, **the code wins**
and the disagreement is recorded; `AUDIT_AND_PLAN.md` is the closest thing to
that plan in this repo, and the brief's own template files were never committed.

### Order verification (the response/revenue invariant)

`Response` gained `verified BOOLEAN NULL` and `unverifiedFailed BOOLEAN NOT NULL
DEFAULT false` (migration `20261012140000_response_verification`, additive).

- At insert, a **known, countable** order (`isCountableOrder`) sets `verified =
  true` and stores the **real** total; an unknown/absent order leaves `verified =
  false` with a null total (Pending, excluded from revenue — never faked $0.00).
- `upsertOrderCache` calls `reconcileOrderForResponses` for the v2 rows too, so a
  late `orders/create` fills the total in (idempotent: only null-total rows).
- `markUnverifiedFailedResponses` (from `maybeMarkUnreconcilable` on a dashboard
  visit) flips rows still order-less after 24 h to `unverifiedFailed = true`.
- `decideSurveyRevenue` excludes `unverifiedFailed`; `verified === null` predates
  the column and keeps the legacy "total present decides" behaviour, so historic
  revenue is unchanged. Do not make the null case mean "unverified".

### Per-token submission cap

`consumeTokenSubmission(token)` (in `app/lib/rate-limit.server.ts`) caps one
checkout session token at `MAX_SUBMISSIONS_PER_TOKEN` (2), keyed on the token's
`jti` and expiring at its `exp`, checked **before** any DB read. Without it the
caller-chosen per-order bucket let one token write unlimited forged answers with
made-up order ids. It is a separate limiter from the per-order `consumeToken`
bucket — both are needed.

### Tags and payload sizes

- `sanitizeTag` strips commas (a comma splits one tag into several), control
  characters and quotes, lower-cases, keeps letters of any script, caps at 40
  chars. The `prefix:channel` colon is **allowed** on purpose. Tag text comes
  from option labels / the merchant prefix; a buyer's free-text "Other" answer
  fills `{channel}` and, before sanitisation, could inject commas.
- `truncateForPayload(value, maxBytes)` is byte-aware (the 3-byte ellipsis is
  inside the budget). `MAX_FLOW_PAYLOAD_BYTES = 45_000` guards
  `flowTriggerReceive`, which ignores — silently, with no run — any payload
  whose keys do not match the trigger's declared fields, and any payload that is
  over-size.

### The Logic map (Phase G)

`shared/logic-tree.ts` `buildLogicTree(survey)` is pure and unit-tested; the UI
(`app/components/logic-map.tsx`) only renders its nodes/warnings. The
"Try it as a shopper" simulator **must** call the shared `isQuestionVisible`;
`tests/unit/logic-tree.test.ts` reads the component source and fails if the
import is dropped or the predicate is inlined. The editor shows it as a
Questions/Logic tab switch over one shared unsaved state.

### The suite must stay serial and the DB guard is not a regression

`npm run check` needs `DATABASE_URL` pointing at `*_test`, or
`tests/db-invariants.test.ts` refuses to run (by design). With the local `.env`
pointing at `sourcetrac`, use the explicit override:

    DATABASE_URL="postgresql://sourcetrac:sourcetrac@127.0.0.1:5432/sourcetrac_test?schema=public" npm run check

Verified 2026-10-12: 624 tests / 50 files green; bundles <= ~11.5 KB compressed.

## Phase 6 — Overview, Results, Home (2026-10-13)

Home (T16) and the channel report are two different screens. **Superseded
2026-10-15** (see "Dashboard, channel report and top navigation" below): `/app`
is now the full Dashboard, and `/app/dashboard` is the channel-attribution
deep-dive. They stay separate pages with different jobs; do not merge them.

`buildSurveyInsights` (`app/lib/insights.server.ts`) joins a stored survey to the
pure aggregation in `shared/templates/stats.ts`. Two silent traps there:

- **Cross-question keys must be resolved.** `resultsHints.crossQuestion` names the
  template's `q_*` keys; the stored survey uses the stable id
  `buildSurveyDefinition` derives. Passing the raw key makes the T14 view never
  appear, with no error. `stableQuestionId(templateId, key)` is the bridge, and
  `tests/unit/insights-build.test.ts` fails on revert.
- **Home resolves template names from the template bundle, not i18n.** Template
  names live in `shared/templates/locales`, so `app._index.tsx` resolves the
  seasonal spotlight and the Channel Compass default server-side with
  `templateText` and passes strings as props. Calling `t()` for them renders a raw
  key.

The admin i18n bundle now carries the `library.*`, `templates.*`, `results.*`,
`studio.*`, `confidence.*`, `ideas.*`, `home.*`, `setup.*`, `ready.*` and
`smart_actions.*` namespaces (279 keys); template *content* is the separate flat
`shared/templates/locales/<code>.json` set (405 keys). `TRANSLATION_REVIEW.md` is
generated from both by `scripts/gen-translation-review.py` for a native pass.

Verified 2026-10-13: `npm run check` = 794 tests / 57 files green.

## Phase 7 — Smart actions applied, and why S10 is a link (2026-10-13)

**T13 was stored but never applied.** `buildWizardSyncOptions` wrote preset ids
into `Survey.syncOptions.presets`, but nothing turned them into Shopify writes:
`runSyncKind` substituted `{channel}` only. A preset tag named
`delivery-check:{optionKey}` would have shipped **literally** as
`delivery-check:optionkey` on every order.

- `resolveSmartActionWrites` (`shared/templates/smart-actions.ts`) is the single
  resolver: preset ids + the response's stored answers → order tags, customer
  tags, customer metafields. Pure; `tests/unit/smart-actions.test.ts` covers it.
  It maps values through `valueMap`, guards on `onlyForOptionKeys`, and bands a
  numeric answer (rating / NPS) through `numericBands`.
- **Tags are built from option keys only.** `optionKeyFor` strips the stable
  question-id prefix (`stableQuestionId(templateId, q)` + `_` + key) back to the
  template key, so a translated label can never reach a tag. The same tag is
  identical in every language.
- `buildWizardSyncOptions` now stores only `{ presets }`; it no longer writes the
  literal tag names (that was the bug above, one layer up).
- `requiredKinds` / `hasSyncWork` / `requiredScopes` all account for presets, or a
  preset-only survey enqueues nothing. A preset `customer_metafield` needs
  `write_customers`, not `write_orders`.
- **A customer metafield's `ownerId` is the customer GID**, not the order GID, and
  its value is the *answer* (not the channel label). The old metafield branch
  always used the order GID.
- **Pro gate at submit, and again at load.** `submitAnswer` deletes
  `options.presets` when `input.plan !== "scale"`. `loadSyncContext` drops them
  again when `effectivePlan(shopRow) !== PLAN_SCALE`, because the lazy sweep
  re-reads `syncOptions` from the database — a shop that downgraded after enqueue
  would otherwise still write. Both use `effectivePlan`, so a cancelled Scale plan
  agrees on both sides. Both skip, neither throws (the same shape as the scope
  gate). `hasSyncWork` counts a preset only if its id is in the dictionary, so an
  unknown id does not enqueue a row that writes nothing.
- **A yes/no answer's canonical field is `numberValue`, not `optionIds`.**
  `survey-rules.ts` defines yes/no as numeric (yes = 1, no = 0), and that is the
  field the validators and the confidence/learn-&-stop code read. The checkout
  extension *also* mirrors the choice into `optionIds` (`["yes"]`/`["no"]`), so
  the stored row carries both. The resolver reads the canonical `numberValue`
  through `answerOptionKey` (mapping 1/0 back to `yes`/`no` via the template's
  question type) and reads option ids only for choice questions. This is a
  robustness fix, **not** a bug fix: the earlier code read `optionIds[0]`, which
  worked solely because of the extension's mirror — a redundant field that a
  future client (or the admin preview) need not send. The `yesNo()` helper in
  `tests/unit/smart-actions.test.ts` pins the numberValue-only shape, and the
  both-shape case is covered too.

**S10 ships the plan's fallback, and the metafield mechanism is feasible (not
impossible).** An earlier note here said the plan's mechanism "does not fit".
That was **wrong** and is corrected: `shopify.appMetafields` is available on
`purchase.thank-you.block.render` (declared with
`[[extensions.targeting.metafields]]`, key + namespace, no `owner_type`), and
`shopify.extension.editor` (`Editor`, `type: 'checkout'`) detects the editor —
both verified against shopify.dev 2026-07 and the installed types. What ships
now is the plan's **step-3 fallback**: an **"Open checkout editor"** link plus
note under the Studio preview caption, opening
`/settings/checkout/editor?page=thank-you` with `target="_top"`. The metafield
preview is deferred as a scope decision (it would add a parallel metafield
read/write path for an admin-only preview), with concrete build steps in
`FUTURE_TASKS.md`. See `TEMPLATES_NOTES.md` for the full reasoning.

**T6 exclusive options have a UI half and a server half, and both must agree.**
`validateResponse` rejects an answer that combines an exclusive option with any
other (`exclusive_with_others`). The `s-choice-list` controls report the whole
new value array on a tap, not which option was tapped, so each surface
reconciles the array against the previous selection: the shared
`reconcileMultiChoiceSelection` / `applyMultiChoiceToggle` in
`shared/survey-rules.ts` (admin preview) and the mirrored `applyExclusiveToggle`
in `extensions/shared/src/survey-logic.ts` (checkout -- it cannot import the
shared module across bundles). `tests/unit/exclusive-option.test.ts` pins the two
to identical behavior, because drift means a buyer's answer is rejected as
`exclusive_with_others` and lost. `tests/unit/survey-rules.test.ts` covers the
server rejection and both helpers.

Verified 2026-10-13: `npm run check` = 834 tests / 59 files green.

## Studio concurrency: `Survey.revision`, never `updatedAt` (2026-10-13)

The Studio's optimistic-concurrency token (section 6.6, "Conflict detection") is
a dedicated `Survey.revision Int @default(0)`, **not** Prisma's `updatedAt`.

`responseCount` is incremented with `survey.update` on every answer, which moves
`@updatedAt`. A conflict check keyed on `updatedAt` would therefore refuse a
merchant's save whenever a shopper answered while the editor was open — a false
conflict on exactly the busiest surveys, and the merchant would be told another
window changed their survey when nobody did. `revision` is bumped only by
merchant writes: `updateSurvey`, `publishSurveyDraft`, `discardSurveyDraft`,
`setSurveyStatus`.

- `updateSurvey(shopId, id, input, expectedRevision?)` and
  `publishSurveyDraft(shopId, id, expectedRevision?)` throw `ConflictError`
  (status 409, code `conflict`) when the stored revision differs.
  **`undefined` skips the check** — older payloads and direct library calls in
  tests do not track a token and must keep working.
- The route passes the form's `revision` through and returns
  `{ ok: false, conflict: true, issues: [] }`; the Studio renders the
  `studio.conflict` banner. That string already existed in all 10 locales but had
  no consumer until now — a locale key with no code reference is the tell.
- `setSurveyStatus` bumps the revision (a merchant action), but the automatic
  learn-&-stop pause in `answers.server.ts` uses its own `updateMany` and does
  **not** — a shopper-driven pause must not invalidate the merchant's editor.
- `tests/db-survey-drafts.test.ts` covers stale save, fresh save, stale publish
  and the false-conflict case (a `responseCount` increment must not move the
  token). Each fails when `assertRevision` is neutered.

## Support contact is a code constant, and it is guarded (2026-10-13)

The App Store listing needs a support contact, and the app must not show a
placeholder. The address lives in `shared/support.ts` as `SUPPORT_EMAIL`; the
`SUPPORT_EMAIL` env var is deprecated and ignored. `buildSupportMailto()` builds
the `mailto:` link (URL-encoded subject and body) with shop, plan, app version
and page prefilled so a support request arrives with context.

`SupportIconButton` sits in the `s-page` `secondary-actions` slot in the shell
(`app/routes/app.tsx`) **and** in that route's ErrorBoundary, so a merchant whose
page fails can still reach support. The Help page uses `SupportContactPanel`, and
`app/root.tsx`'s boundary renders a plain `mailto:` link because App Bridge is not
mounted when the root fails.

- **`s-page` and `s-section` both have a `secondary-actions` slot**, but the
  admin shell owns the only `s-page`; child routes must not nest one.
- **The `slot` prop is typed `Lowercase<string>`**, not `string`. Passing a plain
  `string` fails `tsc` with a confusing error; the component prop is typed to
  match.
- **`process.env` must be read in the loader**, never the component (see the
  root-boundary section above). The version comes from the shell loader.
- **`tests/unit/support.test.ts` is the guard**: link encoding, per-locale
  translation with no leftover placeholder, a scan that fails on any email other
  than `SUPPORT_EMAIL` in `app/` or `shared/`, and source checks that each mount
  point stays wired. A removed button is silent at build time, the same failure
  class as the App Bridge wiring.


## Pricing, navigation and support button (2026-10-15)

- **Prices are $4.99 (Growth) and $9.99 (Scale) a month**, with a yearly cycle at
  `YEARLY_DISCOUNT_PERCENT` (10%) off, derived in `app/lib/plans.ts`
  (`yearlyPriceMinor`), never typed in. Yearly bills on Shopify's `ANNUAL`
  interval; the charge name gets " (yearly)" so `matchPlanByDisplayName` and
  `paidPlanFromSubscriptions` still match on "sourcetrac" + plan name. Do not
  rename the monthly `displayName`: live subscriptions are matched by it.
- **No old-price migration.** The app had no installs when prices dropped from
  $19 / $49, so there is no "switch to the new price" path. If prices change
  again after launch, remember Shopify never re-prices an approved
  subscription: merchants keep the price they approved until they approve a
  new charge. `PLANS_QUERY` already reads each line item's price and interval.
- **The support button opens Gmail compose with `window.open`**, not an `href`.
  A Polaris button `href` is treated by App Bridge as in-app navigation, so the
  old `mailto:` button did nothing inside the admin. Do not pass the
  `noopener` feature to `window.open`: it then returns null even on success.
  `tests/unit/support.test.ts` pins this.
- **Shopify's sidebar is seven items** (its limit, and no item may repeat the
  home page): Surveys, Results, Channel report, Responses, Plans, Settings, Help.
  Results was added 2026-10-15 because NPS lives there and merchants could not
  find it. The in-app top bar lists those plus Dashboard and Export.
- **Page titles come from `export const handle = { titleKey }`**, read by the
  shell's `<s-page heading>`. Child routes must not draw their own title.
- Home and the channel report share `loadChannelReport`
  (`app/lib/channel-report.server.ts`) and the components in
  `app/components/channel-report.tsx`, so their numbers cannot disagree.

## Simplified survey setup and plan gating (2026-10-15)

The three-step Quick setup wizard, the template detail page, the interactive
checkout mock and the Logic map are gone (`checkout-mock.tsx`, `logic-map.tsx`,
`shared/logic-tree.ts`, `preview-model.ts`, `shared/survey-templates.ts`). They
were where merchants got lost, and the mock's device and language switches
disagreed with the real block. Setup is now two screens:

- **Templates** (`app.surveys.library._index.tsx`): plain-named cards showing the
  real questions, "Use template" creates a draft in one step and opens the
  editor. "Start from scratch" is on the same page; the Surveys list has one
  "New survey" button pointing here.
- **Editor** (`app.surveys.$id.tsx`): Questions, Where it shows, Who sees it,
  then folded Optional sections. Go live / Save and publish. A live survey's
  save publishes at once (draft then publish with the new revision).
- **Preview** (`survey-preview.tsx`) is a still picture with every question
  and its follow-up rule. No state, nothing to break.

**Template translations are stored on the survey.** `app/lib/template-survey.ts`
builds the template in every `TEMPLATE_LOCALES` language and stores them as
survey / question / option `translations`. The extension's `localizeSurvey`
reads question- and option-level translations too, and `matchLocale` maps
`de-AT` to `de` and `pt-PT` to `pt-BR`. That is an **extension change**: it
needs `shopify app deploy`, not just a Render redeploy. Option labels identical
to the default ("Instagram") are not stored. Editing a text drops its
translations so buyers never see a stale one. `MAX_COMPILED_CONFIG_BYTES` is now
32 KB per survey (the largest template is ~9 KB with all languages).

**Plan gating lives in `shared/plan-features.ts`** (one table; the Plans page,
editor locks and server checks all read it):

- Free: 1 live survey, 50 answers/month, follow-ups, new vs returning buyers,
  every template's short version, the full "How did you hear about us?".
- Growth: 10 live surveys, unlimited answers, full templates (questions beyond
  `liteQuestionKeys`, "None of these", per-product results), advanced
  targeting (order value, countries, sampling, dates, answer cap).
- Scale: unlimited live surveys (`LIVE_SURVEY_LIMIT.scale` is null; only `MAX_SURVEYS_TOTAL` caps it), Shopify actions (tags, metafields, presets, Flow),
  auto-stop, rotation.

Server enforcement is in `surveys.server.ts` (`plan_live_limit`,
`plan_advanced_targeting`, `plan_shopify_actions`, `plan_auto_stop`,
`plan_rotation`), grandfathering settings a survey already had. A downgraded
shop keeps every survey live but `getCompiledConfig` serves only the plan's
share by priority; nothing is paused. Sync is skipped below Scale in both
`submitAnswer` and `loadSyncContext`. `tests/db-plan-gates.test.ts` and
`tests/unit/survey-setup.test.ts` cover it. DB tests that need several live
surveys put their shop on Scale first.

## Privacy notice, yearly prices and layout (2026-10-15)

- **Layered privacy notice.** `DataNotice` sits under `<Outlet />` in the shell
  so every admin page carries one line on what is stored, linking to
  `/app/privacy` (`DataCollectionDetails`, not in the nav). Just-in-time
  notices (`JustInTimeNotice`) sit on text questions, the Shopify actions panel
  and the export. `tests/unit/data-notice.test.ts` classifies every column of
  `Response`, `Answer` and `OrderCache`; a new column fails it until the notice
  is updated. The public `/privacy` route says the same things in English.
- **`Response.customerId` is never written** (only nulled by `customers/redact`),
  so the notice does not list it. If a sync starts filling it, the test fails:
  add it back to `COLLECTED` and the copy in all ten locales.
- **`Panel` must not set `padding="none"`.** It did, and every Panel's content
  sat against the card edge. `none` is only for full-bleed content, which then
  needs its own `s-box padding`.
- **Multi-condition `@container` values are unverified.** Shopify only documents
  `@container (cond) a, b`. For more than two layouts use plain CSS
  `repeat(auto-fit, minmax(min(100%, Nrem), 1fr))`, which needs no container.
  Two fields side by side use that too, so they stack on a phone.
- **`s-button-group` never wraps**; a row of long labels (date ranges in French)
  uses `s-stack direction="inline"` instead.
- **Yearly price display** is the per-month equivalent, the monthly price struck
  through, the yearly total billed, and the saving in money and percent
  (`yearlySavingMinor`). Copy must stay factual (Built for Shopify 4.3.1): no
  "most popular" or "2 months free" claims.
- **Answers as text** go through `answerParts` (`app/lib/answer-text.ts`) so a
  Yes/No answer reads "Yes", not "yes, 1", on the Responses page and in the
  results CSV.
- Layout here is checked statically only: `cdn.shopify.com` is blocked from this
  container, so Polaris cannot render in a local browser.
- **The survey list's "Updated" date is `Survey.editedAt`**, set only by merchant
  writes alongside `revision`. `updatedAt` moves on every buyer answer, so a busy
  survey always read "Updated today".
- **An unknown billing cycle is `null`** on the Plans page (Shopify unreachable
  or no token). Guessing "monthly" offered a yearly subscriber a switch to yearly.

## Which survey a checkout block shows, and the editor preview (2026-10-15)

- **Each block has a `survey_id` setting** (`[extensions.settings]` in both
  checkout TOMLs, read as `shopify.settings.value.survey_id`, cleaned by
  `cleanSurveyId`). Settings choices can only be static, so the merchant pastes
  the ID; the survey editor shows it with a copy button (`SurveyIdBox`, in
  "Show it in your store").
- **`/api/survey` with `surveyId`:** a pinned block shows that survey or
  **nothing** (paused, draft, other page, targeting miss). Never another survey
  in its place. An id naming no survey **of this shop** falls back to the normal
  pick, so a stale setting never empties the page or reaches another shop.
  `tests/db-survey-pinning.test.ts` covers it.
- **The editor shows the real survey** via `/api/survey-preview` (any status
  when pinned, else the top live survey for the page), with banners for draft,
  paused, wrong page, not found and none live. Preview mode in
  `useMultiSurvey` never POSTs. If the fetch fails the block shows the sample
  with `editorUnavailable`. Whether `sessionToken.get()` works inside the
  checkout editor was not verifiable here; that fallback is the safety net.
- These are extension changes: they need `shopify app deploy`, not only a
  Render redeploy.

## NPS and CSAT scores (2026-10-15)

`npsResult` / `csatResult` in `shared/survey-rules.ts`; `questionScore` in
`survey-analytics.server.ts` attaches one to each breakdown (`nps` for NPS,
`csat` for `rating_5` and `satisfaction_5`, from the fixed option ids). CSAT is
the share of 4–5 answers. Values outside the scale are ignored, and no answers
means `null` (no score shown), never 0. The `customer-satisfaction` template is
the CSAT counterpart of `loyalty-pulse`. Tests: `tests/unit/scores.test.ts`.

## Per-survey statistics and choosing what to export (2026-10-15)

- **Results** has a date range (7 / 30 / 90 days / all time), an "All surveys"
  comparison table (answers, answer rate, revenue, AOV per survey), six KPI
  tiles for the selected survey, a first-order vs returning table, and per
  answer the share, revenue and AOV. Metrics follow what Fairing documents for
  its analytics (count, percent, revenue, AOV per answer, response rate).
- **AOV is per currency**: `CurrencyTotal = { currency, minor, orders }` from
  `rollup`, `aovMinor` divides within one currency. Never add currencies.
- **Answer rate** (`surveyAnswerRates`) = real orders (no test, no cancelled)
  placed since the survey was created, inside the window, that answered it.
  We do not record views, so it is not Fairing's views-based rate, and it
  reads lower for targeted or sampled surveys; the tile's help says so. No
  orders means `null`, never 0%.
- **Export** offers All surveys (default, one row per answer:
  `ALL_SURVEYS_HEADERS`), any single survey (the wide file, identical to the
  Results download) or the original channel file. `/app/export/csv?survey=`
  takes `all`, `channels` or a survey id; an unknown id means all.
  `app/lib/survey-export.server.ts` builds both the file and the page preview.
- Tests: `tests/db-survey-stats.test.ts`.

## Dashboard, channel report and top navigation (2026-10-15)

The merchant reported three things: no way to move around the app, NPS and the
other survey stats nowhere to be found, and Home and the channel report looking
the same. What changed, and the rules that keep it that way:

- **One nav list, two menus.** `app/lib/nav.ts` `NAV` holds every page (key,
  icon, `sidebar` flag). `<s-app-nav>` renders the `sidebar` items; `TopNav`
  (`app/components/top-nav.tsx`) renders all nine at the top of every page,
  marks the current one (`activeNavPath`, whole-segment prefix match, `/app`
  exact only) and announces it to screen readers. Items are `s-clickable href`,
  so navigation goes through App Bridge's `shopify:navigate` and React Router.
  `i18n-usage.test.ts` reads the keys out of `nav.ts`, not `app.tsx`.
- **The menu is a grid of icon tiles, never a scrolling row** (changed
  2026-10-18: the merchant reported the phone row overlapping and rejected
  sideways scrolling). Plain CSS on our own `ul.st-topnav-grid`: 3 / 5 / 9
  columns by iframe width, so nine items always fill whole rows. Each `li` is
  a flex container, which blockifies the `s-clickable` inside it. Do not set
  `display` on the `s-clickable` hosts: that overrides Polaris's own `:host`
  display and can break the element. `top-nav.test.ts` fails on `overflow-x`
  or a column count that leaves a lone tile.
- **`/app` is the Dashboard** (`loadDashboard`, `app/lib/dashboard.server.ts`):
  the four attribution tiles (from `loadChannelReport`, so they always match the
  channel report), Customer scores (shop-wide NPS and CSAT), top 5 channels, new
  vs returning buyers, every live survey's key result, next step, and the trend,
  all under one 7/30/90-day range.
- **Shop-wide NPS is pooled over every answer**, not an average of per-question
  scores (`buildScoreSummary`). CSAT pools `rating_5` and `satisfaction_5`.
  An answer counts only for a question its own survey asks. No answers means
  null (an em dash and an explanation), never 0. A shop with no score question
  at all gets an "Add a survey" button to the loyalty templates instead.
- **One answer set per order across all surveys.** `submitAnswers` refuses a
  second survey's answer on an order that already answered (advisory lock +
  lookup), so a test fixture that answers two surveys on the same order gets
  `duplicate` for the second. `buyerMix` still de-duplicates by order as a
  safeguard, because that figure sums revenue across surveys.
- **The channel report no longer repeats the KPI tiles or the trend.** It is
  the callout, notes, the full table with a Total row, the response-rate line,
  and "In buyers' own words" (`otherAnswers`, the newest 20 written-in "Other"
  answers from `loadChannelReport`).
- **Results shows NPS / CSAT tiles** beside its other numbers; `ScoreBlock`
  moved to `app/components/scores.tsx` and is shared with the Dashboard.
  Dashboard links to Results carry `range=` so the numbers match.
- **Components must import only types from `.server` modules.** A value import
  passes `tsc` and every test and fails only `npm run build`, which
  `npm run check` does not run. That is why the range constants live in
  `app/lib/dashboard-range.ts`. `tests/unit/top-nav.test.ts` now scans
  `app/components/` for it; routes are not covered, so run `npm run build`
  after touching a route's imports.

Tests: `tests/unit/top-nav.test.ts`, `tests/unit/dashboard.test.ts`,
`tests/db-dashboard.test.ts`. Verified 2026-10-15: `npm run check` green and
`npm run build` clean. The bar's look on a real admin was not seen: Polaris
cannot render here (`cdn.shopify.com` is blocked).

## Unsaved survey edits cannot be left behind (2026-10-18)

The editor keeps the survey in local state until Save, so leaving mid-edit
lost the work. `UnsavedChangesGuard` (`app/components/unsaved-changes.tsx`)
closes every exit while `dirty`:

- `ui-save-bar` (App Bridge; shown with `shopify.saveBar.show(id)`, hidden on
  clean and on unmount). Shopify blocks admin navigation while it shows. Its
  `<button>`s need `variant` spread in, since React's button type lacks it.
- `useBlocker` for in-app moves (top menu, links, sidebar taps, which App
  Bridge turns into React Router navigations). Only a pathname change is held
  (`leavesPage`): the editor's own POST and `?saved=1` redirect stay on the
  page and must never be blocked. A held move shows a banner with Save,
  Discard and leave, Keep editing; discarding from the save bar releases it.
- `beforeunload` for reloads.

`tests/unit/unsaved-changes.test.ts` mounts it in a real data router with
happy-dom globals from `tests/helpers/dom-globals.ts` (a `happy-dom` vitest
environment makes the React Router plugin demand its HMR preamble).
What the save bar blocks inside the admin was not observable here.

## Testing paid plans on a development store

No setting is needed. `testChargesAllowed` creates and honours **test**
charges whenever `shop.plan.partnerDevelopment` is true, in production too, so
a Partner development store can approve Growth or Scale on the Plans page for
free. On a real store test charges never grant a plan.

**The app's distribution must be Public first.** Until it is, every
`appSubscriptionCreate` (dev store or not) fails with "Apps without a public
distribution cannot use the Billing API", and custom distribution can never
bill. It is set once in the Partner Dashboard (Apps > SourceTrac >
Distribution > Public distribution), cannot be changed afterwards, and does
not submit the app for review. `isBillingNotEnabled` turns that refusal into
`plans.msg_billing_not_enabled`, which says where to change it.

## Offline tokens must be expiring (2026-10-18)

Shopify answers every Admin API call made with a non-expiring offline token
with `403 [API] Non-expiring access tokens are no longer accepted`. That broke
billing (the Plans page could not read the subscription) and every other Admin
call, while auth itself still succeeded.

- `shopifyApp({ future: { expiringOfflineAccessTokens: true } })` makes token
  exchange ask for an expiring token plus a refresh token. The library
  refreshes it in `authenticate.*` and `unauthenticated.admin`.
- **The library never replaces an offline session with no `expires`**: it reads
  as valid forever. `EncryptedSessionStorage.loadSession` swaps such a session
  for an expiring one on first load (`migrateToExpiringToken` in
  `app/lib/token-migration.server.ts`, the same request as shopify-api's
  helper, which `shopifyApp()` does not expose). Parallel loads share one
  exchange: Shopify revokes the legacy token on the first. If the exchange
  fails the session loads as absent, so the next admin open runs token
  exchange. Nothing is deleted.
- Expiring tokens last about an hour, so `getAccessToken` reads the live
  offline session through `unauthenticated.admin` first. The encrypted copy on
  `Shop` is only a fallback and may be stale.
- A Shopify 4xx now carries Shopify's own text (`httpErrorDetail`), and the
  Plans page shows it. That is how this was found: the log line was not visible.

## "Live" is only claimed where the block has loaded (2026-10-18)

Turning a survey on does not put it in front of buyers: the merchant must add
the SourceTrac block in Shopify's checkout editor, and Shopify exposes no
"block added" state. `Shop.thankYouBlockSeenAt` / `orderStatusBlockSeenAt`
(`app/lib/block-seen.server.ts`) are set when a block calls `/api/survey`
(buyer) or `/api/survey-preview` (checkout editor), at most hourly per process,
and cleared on `app/uninstalled`. The editor and Surveys list show "Buyers
can't see this survey yet" with an Open checkout editor button for any page
the block never loaded on, and after Go live / Save and publish the editor
opens the checkout editor itself (`open_checkout=1`, dropped from the URL and
remembered per revision so Back does not bounce out again). It never opens
once the block has been seen. Tests: `tests/db-block-seen.test.ts`,
`tests/unit/checkout-editor.test.ts`, `tests/unit/shopify-auth-page.test.ts`.

## Speed and the block warning (2026-10-18)

- **The browser bundle carries English only.** `app/lib/i18n/bundled-locales.ts`
  holds all ten locales for the server and vitest; the `browserLocales` plugin
  in `vite.config.ts` swaps in `bundled-locales.browser.ts` for the client
  build (keyed on `options.ssr`). The shell loader sends the merchant's own
  strings as `messages` and `shellTranslator` registers them before render.
  This took the main chunk from 228 KB to 34 KB gzipped. A component that calls
  `createTranslator(lang)` without the shell's `messages` gets English in the
  browser; go through `useAdminI18n()`.
- **The shell loader does not re-run on page switches** (`shouldRevalidate` in
  `app/routes/app.tsx`): only after a form submission or an explicit
  `revalidate()`. Anything the shell shows that a child page changes must be
  changed by a form/fetcher submit, or it stays stale.
- **"Block added" has three sources**: the block loading (`/api/survey`,
  `/api/survey-preview`), a buyer's answer (`/api/survey-responses`), and the
  merchant's "It's already added" button (`markBlockAdded`). The editor preview
  only records if the deployed extension is recent enough to call
  `/api/survey-preview`, which is why the manual confirm exists.

## Checkout loading, pinned surveys and the clickable preview (2026-10-18)

- **The server pings its own `/healthz` every 10 minutes in production**
  (`app/lib/keep-awake.server.ts`, started from `entry.server.tsx`), so Render's
  free plan never sleeps and buyers never wait out a cold start. `/healthz`
  does not touch the database, so Neon still suspends. `KEEP_AWAKE=off`
  disables it. Whether a self-request counts as Render traffic was inferred
  from Render's "inbound traffic" wording, not observed.
- **`/api/survey` runs its reads with `Promise.all`** (block seen, already
  answered, compiled config, order facts, pinned-survey check).
- **Why a pinned survey shows nothing**, in the order they bite: the order
  already answered (one answer per order across both pages and all surveys),
  the survey is beyond the plan's live share (`getCompiledConfig`), audience
  rules, the page is not in its placements, or the checkout editor was not
  saved. `/api/survey-preview` returns `planHidden` and `audienceRules`
  (`hasAudienceRules` in `shared/survey-config.ts`) and the editor block shows
  a banner for each, plus a "test with a new order" line. Extension change:
  needs `shopify app deploy`.
- **The preview fetch gives up at once when the editor refuses a session
  token** (`tokenFailureIsFinal`), instead of a minute of "Loading…". After
  4 s of loading it says the server is starting up.
- **The admin survey preview is clickable again** (`survey-preview.tsx`, rules
  in `app/lib/preview-state.ts`, visibility through the shared
  `isQuestionVisible`). Plain HTML buttons and inputs, never `name`d, all
  `type="button"`. Nothing is saved. Tests: `tests/unit/survey-preview.test.ts`.
