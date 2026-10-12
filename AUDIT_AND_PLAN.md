# SourceTrac — Audit and Plan (Phase 0)

**Date:** 2026-10-12
**Scope:** `survey-app-upgrade-plan.md`, adapted to this codebase.
**Rule applied:** where the plan and the code disagree, the code wins; every
adaptation is written down here.

This document is the audit required by Phase 0. No code has been changed yet.

---

## 1. Stack

| Item | Reality in this repo |
|---|---|
| Framework | **React Router v7** (framework mode), pinned `7.18.2` across `react-router`, `@react-router/*`. `reactRouter()` from `@react-router/dev/vite`. |
| Node | `>=22.12.0`, `.node-version` = `22`. |
| Package manager | npm (`package-lock.json` present). |
| ORM | **Prisma 6.19.3**, PostgreSQL (Neon). `@prisma/client` generated. |
| Language | TypeScript everywhere. |
| Tests | **Vitest 3.2.7**. Unit tests in `tests/unit`, real-Postgres tests `tests/db-*.test.ts`, extension bundle tests in `tests/integration`. |
| Linter | None configured. `npm run check` = typecheck + extension typecheck + `check:extensions` + `check:build-deps` + `test`. |
| Shopify CLI | `@shopify/cli ^4.8.3`. |
| Shopify packages | `@shopify/shopify-app-react-router ^3.0.1`, `@shopify/shopify-app-session-storage-prisma ^11`, `@shopify/ui-extensions 2026.7.4`, `@shopify/polaris-types ^1.1.0`. |
| App Bridge | `AppProvider` from `@shopify/shopify-app-react-router/react`, mounted in `app/routes/app.tsx`. `<s-app-nav>` registers admin nav. |
| UI system | **Polaris web components** (`s-*`) only. No Polaris React anywhere. `app/components/admin-ui.tsx` wraps them. |
| i18n | `i18next` + `react-i18next`, 10 bundled locales, per-request instance. |

**Plan vs code:** the plan assumes the extension may be React/old API. It is not —
both extensions are already `api_version = "2026-07"` with Preact + Polaris web
components. The API-version migration item is therefore a no-op; noted below.

---

## 2. Folder map

```
app/
  routes/            flat file routes (flatRoutes)
    app.tsx          authenticated admin shell (AppProvider + s-app-nav)
    app._index.tsx   dashboard / home
    app.settings.tsx survey settings (the current single question + options)
    app.export.tsx   export page
    app.export_.csv.tsx  CSV resource route
    app.plans.tsx    billing
    app.help.tsx     FAQ
    app.language.tsx language action
    api.survey-config.tsx  GET config for the extension
    api.responses.tsx      POST answer from the extension
    webhooks.tsx     HMAC-verified webhook entry
    healthz.tsx readyz.tsx jobs.retention.ts privacy.tsx auth.$.tsx
  lib/               server + pure logic (see below)
  components/        admin-ui.tsx, language-selector.tsx
  shopify.server.ts  shopifyApp() config
  db.server.ts       single PrismaClient + retryable-error classifier
  session-storage.server.ts  AES-GCM token sealing
prisma/
  schema.prisma
  migrations/        9 migrations
extensions/
  shared/src/        survey-logic.ts, use-survey.ts, SurveyView.tsx (shared by both)
  sourcetrac-thank-you/    handle sourcetrac-survey-thank-you
  sourcetrac-order-status/ handle sourcetrac-survey-order-status
scripts/             dev-postgres.mjs, migrate.mjs, check-extensions.cjs, check-build-deps.cjs
tests/               unit/, integration/, db-*.test.ts
docs/                Phase-1 design docs (01–08)
```

---

## 3. Current data model (prisma/schema.prisma)

| Model | Key columns | Constraints / indexes |
|---|---|---|
| `Shop` | `id`, `shopDomain` (unique), `shopId` (unique), encrypted access token trio, `installState`, `plan`, `planStatus`, `subscriptionGid`, `questionText` (default "How did you hear about us?"), `optionsJson` (default `[]`), `allowOther`, `language`, `adminLocale`, `checkoutSupported` | `@@index([installState])` |
| `SurveyResponse` | `id`, `shopId`, `orderId`, `channel`, `otherText`, `currency`, `orderTotal Decimal(18,3)`, `locale`, `submittedAt`, `isLocked`, `reconciled`, `unreconcilable` | `@@unique([shopId, orderId])`, indexes on `(shopId,submittedAt)`, `(shopId,channel)`, `(shopId,isLocked)`, `(shopId,reconciled)`, `(shopId,orderId)` |
| `OrderCache` | `id`, `shopId`, `orderId`, `orderNumber`, `currency`, `totalPrice Decimal(18,3) NULL`, `financialStatus`, `isTest`, `isCancelled`, `cancelledAt`, `createdAtShop`, `updatedAtShop` | `@@unique([shopId,orderId])`, indexes |
| `WebhookEvent` | `webhookId` (unique), `topic`, `apiVersion`, `shopId?`, `payloadJson` (never written), `processedAt`, `error` | indexes |
| `BillingUsage` | `shopId`, `periodStart`, `periodEnd`, `responsesCount`, `cap` | `@@unique([shopId, periodStart])` |
| `Session` | managed by session-storage lib; includes `refreshToken`, `refreshTokenExpires` | index on `shop` |

**The current survey is a single question with options stored as JSON** on the
`Shop` row (`questionText` + `optionsJson` + `allowOther`). There is **no**
Survey/Question/Option table, no per-response answers table, no daily-stats
table. This is the core gap Phase 2 must close without data loss.

---

## 4. Every place the "6 to 10 options" rule is enforced

| File | Line | What |
|---|---|---|
| `app/lib/settings.ts` | 13–14 | `MIN_OPTIONS = 6`, `MAX_OPTIONS = 10` (the single source of truth today) |
| `app/lib/settings.ts` | 188–202 | `validateSurveySettings` throws `options_too_few` when `< MIN_OPTIONS` |
| `app/lib/settings.ts` | 206–215 | throws `options_too_many` when `> MAX_OPTIONS` |
| `app/routes/app.settings.tsx` | 18, 20, 90–91 | form binds `min`/`max` from those constants; copy "2 to 10" is not yet there |
| `app/routes/app._index.tsx` | 13, 396 | onboarding step 2 text uses `MIN_OPTIONS`/`MAX_OPTIONS` |
| `app/lib/i18n/locales/*.json` | 261–264 | `validation.options_too_few` / `_too_many` messages (10 locales) |
| `tests/unit/settings-csv.test.ts` | 67, 79, 85 | asserts 6 minimum, `MAX_OPTIONS + 2` rejected |
| `tests/unit/validation-i18n.test.ts` | 13, 43 | asserts `MAX_OPTIONS + 1` rejected |

There is **no** database CHECK constraint on option count (options are JSON on
`Shop`). So Phase 1's "write a migration if a CHECK constraint exists" is a
no-op for options.

**Other current limits** (to be reconciled with the plan's `LIMITS`):

| Where | Value |
|---|---|
| `app/lib/settings.ts:15` | `MAX_QUESTION_LENGTH = 120` (plan wants `MAX_QUESTION_TEXT = 200`) |
| `app/lib/settings.ts:16` | `MAX_OPTION_LABEL_LENGTH = 60` (plan wants 80) |
| `app/lib/settings.ts:49` | `EMOJI_MAX_LENGTH = 12` (not in the plan; keep) |
| `app/lib/responses.server.ts:29` | `MAX_OTHER_LENGTH = 140` (plan wants `MAX_TEXT_ANSWER = 500`) |
| `extensions/shared/src/SurveyView.tsx:101` | `maxLength={140}` on the "Other" field |
| `extensions/shared/src/survey-logic.ts` | `SUBMIT_BUDGET_MS = 60_000`, `ATTEMPT_TIMEOUT_MS = 30_000` |

---

## 5. Extensions

| | `sourcetrac-thank-you` | `sourcetrac-order-status` |
|---|---|---|
| Handle | `sourcetrac-survey-thank-you` | `sourcetrac-survey-order-status` |
| Target | `purchase.thank-you.block.render` | `customer-account.order-status.block.render` |
| `api_version` | `2026-07` | `2026-07` |
| Type | `ui_extension` | `ui_extension` |
| Capabilities | `network_access = true` (+ non-schema `allowed_urls`) | same |
| Rendering | Preact 10 + `@shopify/ui-extensions/preact`, Polaris web components | same |
| Entry | default export called as a plain function | same |
| Locales | 10 files incl. `en.default.json` | 10 files |
| Bundle size | small (esbuild, no libraries). `tests/integration/extension-bundle.test.ts` builds each with the CLI's exact entry. |

**Plan vs code:** the plan's "upgrade if older than 2026-01 / migrate off React"
is **already satisfied**. No handle or target change is needed. `allowed_urls`
is **not** part of Shopify's schema (the CLI ignores it) but `check-extensions.cjs`
asserts it names the same host as the literal `API_URL`; keep it as documentation.

---

## 6. Config (shopify.app.toml)

- **Scopes:** `read_orders` only. `assertStartupInvariants` warns if any other
  scope is added, and `SCOPES` in `.env.example` is `read_orders`.
- **Webhook subscriptions:** `orders/create`, `orders/updated`, `orders/cancelled`,
  `app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, and the
  compliance trio `customers/data_request`, `customers/redact`, `shop/redact`.
- **Compliance handlers delete data:** yes. `app/lib/compliance.server.ts` +
  `app/routes/webhooks.tsx` implement all three; `handleShopRedact` deletes the
  shop row (FK cascade removes responses/orders/usage/webhook events and
  sessions), `handleCustomerRedact` deletes by `orders_to_redact`. Tested in
  `tests/db-compliance.test.ts`.
- **`api_version`** `2026-07`.

---

## 7. Data flow

- **Config fetch:** `GET /api/survey-config?orderId=<id>` with
  `Authorization: Bearer <session token>`. Auth via
  `authenticate.public.checkout(request)` → `{ sessionToken, cors }`. Shop
  identity is `sessionToken.dest`. Returns
  `{ enabled, questionText, options, allowOther, orderId, alreadyAnswered }`.
- **Submit:** `POST /api/responses` body `{ orderId, channel, otherText, locale }`.
  Allowlists `channel` against the merchant's options. Returns
  `{ ok, counted }` for both fresh and duplicate.
- **Order link:** `SurveyResponse.orderId` is the numeric id from
  `orders/create` (`String(order.id)`); the extensions send GIDs which
  `orderIdSchema` normalises. `OrderCache` joined on `(shopId, orderId)`.
- **CORS:** `authenticate.public.checkout` supplies `cors()`; every exit is
  wrapped `cors(toResponse(...))` so a thrown 400 still carries
  `Access-Control-Allow-Origin: *`.
- **Bot filter:** the Shopify library rejects bot User-Agents with 410 before
  auth runs. Tests must send a browser UA.

---

## 8. Billing

**Billing exists.** Plans `free` (cap 50), `growth` ($19), `scale` ($49) in
`app/lib/plans.ts`; Billing API `appSubscriptionCreate` in
`app/lib/billing.server.ts`; `app/routes/app.plans.tsx` reconciles from Shopify.
Plan gating rules in Phase 6 therefore apply (do not add billing; do follow the
gating rules).

---

## 9. Baseline (recorded before any change)

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run typecheck:extensions` | **PASS** |
| `npm run check:extensions` | **PASS** (both handles/targets ok) |
| `npm run check:build-deps` | **PASS** |
| `npm run build` | **PASS** |
| `npx vitest run --no-file-parallelism` | **PASS — 37 files, 452 tests** |

**Note on the DB tests:** `npx vitest run` with default (file-parallel) settings
intermittently fails `tests/db-invariants.test.ts` because DB test files share
one Postgres and delete overlapping shop rows. Serial execution
(`--no-file-parallelism`) is green. This is a pre-existing test-harness race, not
a product bug; it is recorded here and left alone.

Environment needed to run them: embedded Postgres via
`node scripts/dev-postgres.mjs start --hold` (detached), a `.env`, and
`DATABASE_URL=...sourcetrac_test` for the DB suite.

---

## 10. Neon connection

- Runtime uses `DATABASE_URL` (the pooled `-pooler` host in production).
- `scripts/migrate.mjs` migrates against `DIRECT_URL`, or `DATABASE_URL` with
  `-pooler` stripped (PgBouncer transaction mode cannot hold Prisma's advisory
  lock), retrying while Neon wakes.
- One `PrismaClient` singleton on `globalThis`. `P1017`/`P1002` are retryable.

---

## 11. Plan adapted to this codebase, order, and risks

The plan is followed in order. Adaptations forced by the code:

### Phase 1 — Shared rules
- Create **`shared/survey-rules.ts`** at repo root (new top-level `shared/`
  folder), TypeScript, zero dependencies.
- **Admin/server** import it via a tsconfig path alias `@shared/* -> ./shared/*`.
  (Prisma/server code must not import from `extensions/`.)
- **Extensions** import it via a **relative path** `../../shared/survey-rules`.
  The CLI bundles with esbuild and `bundle: true`, so a relative import into a
  sibling folder works; verified by `tests/integration/extension-bundle.test.ts`.
- The current option rules live in `app/lib/settings.ts`. Keep that module as
  the settings **form** layer, but re-export the limits from `shared/survey-rules.ts`
  so there is one source of truth (`MIN_OPTIONS`, `MAX_OPTIONS`).
- Change `MIN_OPTIONS` 6 → **2**. Keep `MAX_OPTIONS` 10.

### Phase 2 — Data model and migration
- Add `Survey`, `Question`, `Option`, `Response`, `Answer`, `SurveyDailyStats`,
  `PendingSync`, `PendingDeletion`, `DataRequest` models (Appendix C), adapted
  to the existing naming.
- **Lossless backfill** from the current single-question shape: every existing
  `Shop` becomes one `Survey` + one `single_choice` `Question` + its `Option`s
  (keep option `value`s); every existing `SurveyResponse` becomes a `Response`
  + one `Answer` pointing at the option. Keep `SurveyResponse` and its columns
  in place (deprecated) — the plan forbids dropping columns this release.
- Money stays `Decimal(18,3)` (already correct); new money columns match.
- Migration is one commit; nothing unrelated mixed in.

### Phase 3 — Survey editor
- New routes under `/app/surveys*`. Replace the single-question Settings page
  with a survey list + editor, keeping `/app/settings` working (redirect/keep)
  so bookmarked URLs do not break.
- Polaris web components throughout (already the house style).
- Templates in a new module; live preview in the editor.

### Phase 4 — Checkout survey
- Extension API version already current; **no handle/target change**.
- Add a compiled-config delivery. The plan prefers an **app-owned shop
  metafield**; a checkout extension can read a declared metafield directly.
  **Risk / open question:** the exact metafield declaration syntax changed on
  2026-10-08 (`owner_type`), and this container cannot reach shopify.dev to
  verify it. **Decision:** implement the **in-memory cache + GET endpoint**
  fallback first (which the plan explicitly allows and which needs no Partner
  Dashboard change), and record the metafield path in `FUTURE_TASKS.md`. This
  keeps the free tier and avoids a deploy blocker we cannot verify here.
- Multi-question rendering in Preact; per-type components; show-if; one-at-a-time.
- Submit becomes `POST /api/survey-responses` with `{ surveyId, surveyVersion,
  placement, answers[], ... }`. **Keep `/api/responses` working** for the
  already-deployed extension until the new one ships, then the old route can be
  retired (not deleted this release).

### Phase 5 — Results, responses, export
- New `/app/results` and `/app/responses` pages; extend the existing CSV.
- Reuse `money.ts`, `revenue.ts`, `analytics.ts` (already correct, currency-safe).
- Keep the existing dashboard channel report working.

### Phase 6 — Home, settings, help
- Rework `app._index.tsx` into the setup-status home; add settings sections
  (retention, sync) and extend help. Plan gating already exists.

### Phase 7 — Shopify sync
- **New scopes required:** `write_orders` (order tags/metafields),
  `write_customers` (customer tags/metafields), `read_products` (collection
  targeting). This is the biggest risk: `assertStartupInvariants` currently
  warns on any scope beyond `read_orders`, and existing merchants must re-approve.
  **Decision:** add scopes but gate every Phase 7 feature on the **granted**
  scopes at runtime, so a merchant who has not approved them keeps working, and
  update `assertStartupInvariants`'s allowlist deliberately.
- Admin blocks (`admin.order-details.block.render`,
  `admin.customer-details.block.render`) and a Flow trigger
  (`flow_trigger`) — new extension folders, new handles, never renamed.
- **Verify** target names and Flow syntax against docs where reachable; note
  what could not be verified.

### Phase 8 — Privacy
- Extend the existing compliance handlers to the new tables; keep the "other
  shop untouched" test. Add `PendingDeletion` batching.

### Bonus
- B1 (theme app extension) and B2 (App Proxy link) behind
  `shared/feature-flags.ts`, **off by default**. Only after Core is stable.

### Risks summary
1. **Data migration** — highest risk. Mitigated by additive schema + backfill +
   fixture test + keeping old columns.
2. **Extension API upgrade** — not needed; already current.
3. **New scopes** — merchants must re-approve; gated at runtime.
4. **Protected customer data** — stays Level 1 (no names/emails/phones/addresses
   ever read or stored). Order/customer metafields need Level 1 approval.
5. **Metafield delivery for the compiled config** — cannot verify the
   declaration syntax offline; using the allowed cache+endpoint fallback.

---

## 12. Decisions on ambiguous points

- **"6 to 10 options" fix:** min becomes 2, max stays 10.
- **Existing 6–10 option surveys:** unchanged; the new min only relaxes.
- **`otherText` length:** plan says 500; current is 140. Raise to 500 for the new
  answer model (`LIMITS.MAX_TEXT_ANSWER`), keeping 140 handling backward
  compatible for the old route during the transition.
- **Question text length:** plan wants 200, current 120. Use `LIMITS.MAX_QUESTION_TEXT = 200`.
- **Option label length:** plan wants 80, current 60. Use `LIMITS.MAX_OPTION_LABEL = 80`.
- **Compiled-config delivery:** cache + endpoint, not metafield (offline-verifiable).
- **`/api/responses`:** kept for backward compatibility; new `/api/survey-responses`
  added.

---

*End of Phase 0 audit. Proceeding to Phase 1.*
