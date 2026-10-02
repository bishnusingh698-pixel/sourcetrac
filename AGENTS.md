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
type system cannot catch a GID/numeric mismatch**; the evidence is that the
webhook stores `String(order.id)` from the REST payload.

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

## Checkout extensions: verified 2026-07 APIs

Targets: `purchase.thank-you.block.render` and
`customer-account.order-status.block.render`.

**The npm package version and the declared `api_version` are independent.** The
extension TOML declares `api_version = "2026-07"`, and the Admin API calls
`SHOPIFY_API_VERSION=2026-07`. Neither is affected by which npm package version
is installed. Pinning the packages to 2025.7.4 does **not** mean targeting an old
API — it only chooses which binding layer is available.

### Build dependency invariant (do not "fix" by moving packages)
Render omits devDependencies, but the build needs several of them. `.npmrc` sets
`include=dev` to keep them. `npm run check:build-deps` fails if `.npmrc` loses
that line or if a build config imports an undeclared package.

`prisma` is the exception and must stay in `dependencies`: it is a
*peerDependency* of `@prisma/client`, so nothing else provides its CLI, and
`prisma generate` is what makes `@prisma/client` importable at build time.
Moving `vite` / `vite-tsconfig-paths` into `dependencies` to chase a build error
is the wrong fix and bloats the runtime image.

**Both packages must stay on the same exact version.** The React wrapper declares
an exact-version peer on the core package, so any mismatch fails `npm ci` with
`ERESOLVE` before the build starts.

The two available engines, verified from the published `dependencies`:

| Core package | Rendering engine | Binding |
|---|---|---|
| `2026.x` | `preact` + `@preact/signals` (peer) | `@shopify/ui-extensions/preact` |
| `2025.7.x` | `@remote-ui/core` | `@shopify/ui-extensions-react/*` |

So the real choice is **Preact/web-components or React/remote-ui** — not "old vs
new API". `2026.x` has no React binding published, which is why the aligned
2025.7.4 pair is the only way to keep this React code. Migrating to 2026.x means
rewriting both blocks onto `@shopify/ui-extensions/preact` plus Polaris web
components (`s-stack`, `s-clickable`, …), which is the direction Phase 1 research
already identified as the long-term target.

**Upgrade path when Shopify ships a 2026.x React binding:** bump both packages
together and re-check the render APIs. In 2025.7.x those APIs are **remote
subscribables, not plain objects** — `api.orderConfirmation.value` and
`api.order.value` do not exist. Unwrap them with `useRemoteSubscription` from
`@remote-ui/react`, which is a transitive dependency (do not add it directly: its
React peer range excludes React 19 and that breaks `npm ci`).

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
- That `id` is the **numeric** order id — the same value `orders/create` puts in
  `order_id` — not the `gid://shopify/Order/...` GID. Both API routes reject a
  non-numeric `orderId` with a 422. Test fixtures must match; an older fixture
  using a GID still passed because the client is id-agnostic and never ran the
  route's validator.
- Both blocks therefore call `useSurvey(orderId ?? "", ...)`, because the id
  arrives from an async remote-ui subscription and is undefined on first render.
  `useSurvey` must early-return on an empty id, or every page load fires
  `?orderId=`, which 422s as a permanent failure and logs a give-up.
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

Refunds only reduce revenue once Shopify reports `financialStatus` as
`partially_refunded`. Before that flip the refund amount is ignored, because the
refund may still be in dispute.

### Never reconcile from an unparsed total

`OrderCache.totalPrice` is `NOT NULL`, so `upsertOrderCache` must write
*something* when `parseMoneyToMinor` rejects the payload. It writes `"0.00"` —
and that value is safe **only** because `upsertOrderCache` returns before
calling `reconcileResponsesForOrder` when `!totalParsed.ok`.

Passing the fallback through would defeat the guard in
`reconcileResponsesForOrder`, which exists precisely to catch an unparseable
total: `"0.00"` parses cleanly, so every waiting response would be stamped with
a zero order total and silently stop counting as revenue. The merchant would see
a real order reported at $0.00, indistinguishable from a genuine free order.
Unreconciled ("Pending") is the honest state.

If you make `totalPrice` nullable, delete this guard in the same commit — it
becomes redundant but the fallback string stays dangerous.

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
