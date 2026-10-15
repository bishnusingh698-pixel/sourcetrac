# SourceTrac bug audit (2026-10-15)

Read-only audit. Fixed items are ticked `[x]`; ambiguous fixes are recorded in
`DECISIONS.md`. Findings that turned out not to be real bugs on closer
inspection were removed (S1-3, I1, I3, I4, I10, I12, I13, I23, I26, I27; and I16,
which the installed `@shopify/ui-extensions` 2026.7 types settle: the
thank-you `order.id` "becomes the Order object ID in the GraphQL Admin API"; L25,
whose re-stored row holds a token Shopify already revoked and is removed by
`shop/redact`; L29, where an order-less answer has no link to any customer for a
redact to follow and ages out with retention; and I7, ledger rows that hold no
personal data and are purged after 30 days).

Original note: no application code was changed by the audit. Every finding names a file and
line, and gives a concrete scenario that triggers it.

- **CONFIRMED**: the path was traced through the code.
- **PLAUSIBLE**: the finding depends on Shopify or runtime behaviour that could
  not be checked offline. shopify.dev is blocked from this container.

The findings come from eight end-to-end flow traces:

| Tag | Flow |
| --- | --- |
| AUTH | install / auth |
| SUBMIT | survey display and submit |
| ORD | order webhooks |
| GDPR | uninstall, GDPR and retention |
| BILL | billing |
| SYNC | Shopify sync and admin blocks |
| EDIT | survey editor |
| REP | reporting and export |

Findings that several traces reported separately are merged into one entry.

---

## Step 1: API version, packages, GraphQL validation

### Versions in use

| Item | Value | Notes |
| --- | --- | --- |
| Admin API version | `2026-07` | Set in `shopify.app.toml` (`[webhooks] api_version`, `scopes_api_version`), all 5 `extensions/*/shopify.extension.toml`, `.env.example` `SHOPIFY_API_VERSION`. Shopify's Dev MCP 1.16.1 (published 2026-10-14) marks 2026-07 as `latestVersion` and 2026-10 as `releaseCandidate`, so 2026-07 is current. |
| `@shopify/shopify-app-react-router` | 3.0.1 (locked) | 3.0.2 available |
| `@shopify/shopify-api` (transitive) | 15.0.0 | 15.0.1 available |
| `@shopify/shopify-app-session-storage-prisma` | 11.0.0 | 11.0.1 available |
| `@shopify/admin-api-client` (transitive) | 2.0.0 | 2.0.1 available |
| `@shopify/ui-extensions` | 2026.7.4 | Matches the `2026-07` dist-tag. A `2026-10` tag (2026.10.0) exists. |
| `@shopify/cli` (dev) | 4.8.3 | 4.9.4 available |
| `@shopify/polaris-types` | 1.1.0 | Current |
| `@prisma/client` / `prisma` | 6.19.3 | 7.x is a major upgrade, not required |
| `react-router` / `@react-router/*` | 7.18.2 | 8.x is a major upgrade, not required |

None of the installed versions is marked deprecated on npm. The Shopify packages
are only behind by patch releases. The lockfile pins the older patches even
though `package.json` uses caret ranges.

### GraphQL validation

**Method.** The Shopify AI Toolkit plugin is not enabled in this session, and
shopify.dev is blocked by the network policy. So I used the toolkit's own
validation engine instead: Shopify's official Dev MCP package
(`@shopify/dev-mcp` 1.16.1). It ships the Admin GraphQL introspection schemas.
Every `#graphql` operation in the repo was parsed and validated with graphql-js
against Admin `2026-07` and `2026-10`, using the standard rules plus
`NoDeprecatedCustomRule`. No other GraphQL strings exist. The admin and checkout
extensions call only the app's own backend.

| Operation | File:line | 2026-07 | 2026-10 | Deprecated |
| --- | --- | --- | --- | --- |
| `SourceTracCreateSubscription` (appSubscriptionCreate) | app/lib/billing.server.ts:18 | valid | valid | none |
| `SourceTracCancelSubscription` (appSubscriptionCancel) | app/lib/billing.server.ts:41 | valid | valid | none |
| `SourceTracPlans` | app/lib/shopify-graphql.server.ts:135 | valid | valid | none |
| `SourceTracShopStatus` | app/lib/shopify-graphql.server.ts:149 | valid | valid | none |
| `SourceTracShopTimezone` | app/lib/shopify-graphql.server.ts:159 | valid | valid | none |
| `SourceTracShopDisplay` | app/lib/shopify-graphql.server.ts:170 | valid | valid | **`Product.featuredImage`** (use `featuredMedia`) |
| `SourceTracProductTitles` | app/lib/shopify-graphql.server.ts:248 | valid | valid | none |
| `SourceTracShopTimezoneOnly` | app/lib/shopify-graphql.server.ts:316 | valid | valid | none |
| `SourceTracPlan` | app/lib/shopify-rest.server.ts:115 | valid | valid | none |
| `SourceTracTagsAdd` (tagsAdd) | app/lib/sync.server.ts:157 | valid | valid | none |
| `SourceTracMetafieldsSet` (metafieldsSet) | app/lib/sync.server.ts:166 | valid | valid | none |
| `SourceTracFlowReceive` (flowTriggerReceive) | app/lib/sync.server.ts:175 | valid | valid | none |
| `SourceTracOrderCustomer` | app/lib/sync.server.ts:183 | valid | valid | none |
| `SourceTracCustomerOrders` | app/lib/admin-survey-context.server.ts:86 | valid | valid | none |
| `SourceTracOrder` | app/lib/order-backfill.server.ts:25 | valid | valid | none |

`userErrors` handling for every mutation:

- `appSubscriptionCreate` / `appSubscriptionCancel`: checked at
  `billing.server.ts:120` and `:156`.
- `tagsAdd`, `metafieldsSet`, `flowTriggerReceive`: checked by
  `assertNoUserErrors` at `sync.server.ts:411,432,499,528`.

### REST

No REST Admin endpoints are called. Every Admin call goes to
`/admin/api/<version>/graphql.json`. The order and app webhooks deliver
REST-shaped JSON payloads, which is expected.

`app/lib/shopify-rest.server.ts` uses only GraphQL despite its name. The header
comment of `app/lib/shopify-graphql.server.ts:8-10` ("Uses the Admin REST API for
the shop endpoint") is stale.

### Step 1 findings

- [ ] **S1-1 Low (CONFIRMED): a deprecated field is still queried.**
  - Where: `app/lib/shopify-graphql.server.ts:182` (consumed at `:210-216`).
  - Defect: `Product.featuredImage` is deprecated.
  - Scenario: when Shopify removes the field in a future version, the whole
    `SourceTracShopDisplay` query errors. That query also returns the shop name
    and currency, so all three go blank in the Studio mock. The query is caught
    and returns nulls, so the failure is safe.
- [ ] **S1-2 Low (CONFIRMED): the API version is not pinned in code.**
  - Where: `app/lib/env.ts:25` and `app/shopify.server.ts:18`.
  - Defect: `SHOPIFY_API_VERSION` is validated only by the regex
    `^\d{4}-\d{2}$` and then cast with `as ApiVersion`. Nothing checks it
    against `shopify.app.toml` or the extensions' `api_version`.
  - Scenario: a deploy sets `SHOPIFY_API_VERSION=2025-07`, or a typo like
    `2026-08`. The admin calls then run against a different schema than the
    webhooks and extensions, or 404 on every Admin call.
- [ ] **S1-4 Info (PLAUSIBLE): an unrecognised config key.**
  - Where: `shopify.app.toml:23`.
  - Defect: `scopes_api_version` is not a known app-configuration key. It is
    either ignored or rejected by the CLI.
  - Related: the `SCOPES` env var is never compared with `[access_scopes]`;
    `assertStartupInvariants` only allowlists scope names.
- [ ] **S1-5 Info (CONFIRMED): the declared scopes contradict the stated posture.**
  - Where: `shopify.app.toml:19`.
  - Defect: the app requests `write_orders`, `write_customers` and
    `read_products`, but the toml comment and project notes say `read_orders`
    is the only scope (protected-customer-data Level 1).
  - Scenario: `write_customers` plus customer metafield writes put the app into
    protected customer data review. The listing and privacy docs must match.

---

## Critical

### [x] C1. The backfill migration fails as soon as two shops share an option value (GDPR/SYNC) — CONFIRMED

- **Where:** `prisma/migrations/20261012095226_multi_question_survey/migration.sql:292-293` (table at `:68-78`).
- **Defect:** the backfill inserts each legacy option with `"Option"."id" = option_value`. `Option.id` is a primary key that is global across all shops.
- **Scenario:**
  1. The production database holds two or more shops. Every shop was seeded with the same default survey (`google`, `instagram`, …).
  2. The second shop's `INSERT INTO "Option"` raises `duplicate key value violates unique constraint "Option_pkey"`, and the whole `DO $backfill$` block aborts.
  3. `npm run start` runs `scripts/migrate.mjs` first, so the deploy fails to boot.
- **Why the test missed it:** `tests/db-migration-backfill.test.ts:83` seeds a single shop.
- **Related:** even if this were worked around, `sync.server.ts:259` and `admin-survey-context.server.ts:44` look up labels by option id alone, with no shop scope.

### [x] C2. A required question that was removed still blocks every submission (SUBMIT) — CONFIRMED

- **Where:** `shared/survey-rules.ts:663-685`, with `app/lib/surveys.server.ts:481-486`, `:140-145` and `:262-270`.
- **Defect:** on a survey with answers, removing a question archives it but keeps `required: true`. `getSurveyRow` loads archived questions, `rowToEditor` passes them into the submit definition (`api.survey-responses.tsx:127-136`), and `validateResponse` checks every question, archived ones included. Buyers never see the archived question, because `compileSurvey` hides it.
- **Scenario:**
  1. A merchant deletes a required question from a live survey that already has answers.
  2. Every later submission returns 400 `required`.
  3. The extension treats a 400 as permanent and drops the answer.
- **Result:** 100% of answers for that survey are lost silently.

### [x] C3. Buyer answers are validated against the merchant's unpublished draft (SUBMIT) — CONFIRMED

- **Where:** `app/routes/api.survey-responses.tsx:127` and `app/lib/surveys.server.ts:197-215`.
- **Defect:** `rowToEditor` returns the draft whenever `row.draft` is set. Saving a live or paused survey always creates a draft (`surveys.server.ts:640-645`), while buyers keep being served the published version.
- **Scenario:**
  1. The merchant saves, without publishing, a draft that does any of these:
     - adds a required question;
     - removes a question;
     - removes an option.
  2. Every buyer submission fails with `required`, `unknown_question` or `unknown_option` (a 400) until publish.
- **Result:** the answers are lost.

### [x] C4. Dashboard, Export and the main CSV never show answers collected by the current checkout blocks (REP) — CONFIRMED

- **Where:** `app/lib/analytics-queries.server.ts:85` (`FROM "SurveyResponse"`), `app/routes/app.export.tsx:35` and `app/routes/app.export_.csv.tsx`.
- **Defect:** these read only the legacy v1 `SurveyResponse` table. Both checkout blocks use `useMultiSurvey` (`ThankYouBlock.tsx:73`, `OrderStatusBlock.tsx:65`) and post to `/api/survey-responses`, which writes only v2 `Response`.
- **Scenario:** any shop installed after the multi-question release:
  - the Dashboard shows the empty state while Home says "live";
  - Export reports no answers;
  - `/app/export/csv` contains only migrated history.

  The core "channel → revenue" report is empty.

### [x] C5. Template surveys lose their stable question and option ids, which breaks follow-ups, smart actions and insights (EDIT/SYNC) — CONFIRMED

- **Where:** `app/lib/surveys.server.ts:409-413` and `:437-463`, with `shared/templates/resolve.ts:108` and `:177`, `shared/templates/smart-actions.ts:288-295` and `app/lib/insights.server.ts:151`.
- **Defect:** `persistQuestions` keeps a posted id only if it already exists in that survey, so a new survey gets fresh cuids. Template `showIf` conditions are stored verbatim, still referencing `stableQuestionId(...)` ids that no longer exist.
- **Scenario:** a merchant creates any template with a follow-up (`did-you-compare`, `first-time-vs-returning`, the legacy "q2 if q1 = Instagram"):
  - `isQuestionVisible` never finds the parent answer, so the follow-up never shows;
  - the next Studio save fails with `show_if_unknown`;
  - smart-action presets (T13) look answers up by stable id, never match, and the PendingSync row is deleted as "done";
  - cross-question insights (T14) never appear.
- **Note:** persisting the stable ids as-is would collide on the global `Question.id` primary key the second time a template is used.

---

## High

### Survey submission (buyer side)

- [x] **H1 (CONFIRMED): single-question surveys submit on the first keystroke or tick.**
  - Where: `extensions/shared/src/use-multi-survey.ts:253-264` (inputs at `MultiSurveyView.tsx:276,284,292`).
  - Defect: with layout `all`, every `onAnswer` on a single-question survey submits immediately, and text inputs call `onAnswer` on every keystroke.
  - Scenarios:
    - A buyer selects "Other" and types "a". `otherText: "a"` is submitted, and the rest of the typing is ignored (`:248`).
    - A single text question submits its first character.
    - A single multi-choice question submits on the first tick. With `minSelections ≥ 2` it returns 400 and the answer is lost.

### Order webhooks and revenue

- [x] **H2 (CONFIRMED): an answer can stay Pending forever when the order lands mid-submit.**
  - Where: `app/lib/answers.server.ts:197-206`; the only v2 reconcile is `webhooks.server.ts:472`.
  - Defect: the v2 submit reads `OrderCache`, then inserts, and never reconciles after the insert. There is no v2 orphan sweep, unlike legacy `responses.server.ts:130,290`.
  - Scenario:
    1. The buyer submits and finds no order.
    2. `orders/create` writes `OrderCache`, and its `updateMany` finds no Response yet.
    3. The submit then inserts with `orderTotal = NULL`.
  - Result: the answer stays Pending. After 24h `markUnverifiedFailedResponses` sets `unverifiedFailed`, and that revenue is permanently excluded.
- [x] **H3 (CONFIRMED): a failed v2 reconcile is swallowed and the webhook returns 200.**
  - Where: `app/lib/webhooks.server.ts:479-485`.
  - Defect: a DB error in `reconcileOrderForResponses` is logged as a warning, and the route still answers 200.
  - Scenario: a transient DB error after the order row is written. Shopify stops retrying, and with H2 the answer becomes `unverifiedFailed`. The legacy reconcile at `:459` is not wrapped and correctly returns 500.
- [x] **H4 (CONFIRMED): orders missed by webhooks are never backfilled for v2 answers.**
  - Where: `app/lib/order-backfill.server.ts:106` (`FROM "SurveyResponse" r`).
  - Defect: `backfillMissingOrders` only looks for missing orders behind legacy rows. Its v2 callers (`app.results.tsx:32`, `app.responses.tsx:33`, `app.results_.csv.tsx:42`) expect it to cover them.
  - Scenario: an order placed before install or during an uninstall gap (webhooks dropped at `webhooks.server.ts:267-271`). The v2 answer never gets an `OrderCache` row and becomes `unverifiedFailed`.

### Reporting

- [x] **H5 (CONFIRMED that it cannot serialise; the exact symptom is PLAUSIBLE): the Results loader returns a function.**
  - Where: `app/routes/app.results.tsx:39`, `:43` and `:99` (called at `:187`).
  - Defect: the loader returns `amount`, a function. A function cannot reach the client.
  - Scenario: open Results for a survey with any counted revenue. `data.amount(...)` is not a function in the browser, so either turbo-stream fails to encode or a TypeError hits the error boundary.
  - Same pattern: `app/routes/app.surveys.library.$id.tsx:70/76` returns `questionTypeLabel` (Info, PLAUSIBLE).
- [x] **H6 (CONFIRMED): Dashboard range buttons go to Home.**
  - Where: `app/routes/app.dashboard.tsx:385`.
  - Defect: the buttons link to `/app?range=N` (Home), not `/app/dashboard?range=N`.
  - Scenario: clicking "Last 7 days" or "Last 90 days" leaves the Dashboard, so it is stuck on 30 days.
- [x] **H7 (CONFIRMED): satisfaction stats are always empty.**
  - Where: `shared/templates/stats.ts:45` and `:98`.
  - Defect: `satisfaction_5` is aggregated from `numberValue`, but the extension stores it as `optionIds: [id], numberValue: null` (`MultiSurveyView.tsx:241`, `answers.server.ts:229`).
  - Scenario: a satisfaction main question gives an always-null `average`.
    - Home shows "—" yet still says "reliable" / "ideas ready".
    - Idea rules that depend on the average never fire.
- [x] **H8 (CONFIRMED): Results show no bars for yes/no and satisfaction questions.**
  - Where: `app/lib/survey-analytics.server.ts:280`.
  - Defect: breakdowns list only merchant `Option` rows. `yes_no` and `satisfaction_5` use fixed ids and have no Option rows.
  - Scenario: Results for any yes/no or satisfaction question shows "N answered" with no bars.

### Survey editor

- [x] **H9 (CONFIRMED): "Go live" always fails with a 500.**
  - Where: `app/routes/app.surveys.$id.tsx:159-162` versus `:177` (button `:515`, `submitIntent` `:321-326`).
  - Defect: `submitIntent("go-live")` posts only `intent` and `revision`. The action throws "The survey was not submitted" before it reaches the `go-live` branch, and `guarded()` turns that into a 500.
  - Scenario: any merchant clicks the primary "Go live" button. The survey is never activated.
- [x] **H10 (CONFIRMED): two new options collide on an empty id.**
  - Where: `app/components/survey-editor.tsx:247-254`, `:269-270`, `:489` → `app/lib/surveys.server.ts:315-320` → `shared/survey-rules.ts:568`.
  - Defect: new options get `id: ""`. `option.id ?? placeholder` does not replace `""`, so two new options share an id and validation fails with `duplicate_option`.
  - Scenario: "Add question" (which creates two default options), "Duplicate question", or adding two options, then Save. The save is refused, so merchants cannot add a choice question from the Studio.
- [x] **H11 (CONFIRMED): deleted questions and options come back on the next save.**
  - Where: `app/lib/surveys.server.ts:262-270`, `:429` and `:451` (also `:810-813`).
  - Defect: archived questions and options are sent to the editor and posted back, and `persistQuestions` writes `archived: false` on every posted row.
  - Scenario: on a survey with answers, delete option "TikTok" and save. Reload, edit anything, and save again: "TikTok" is live for buyers again.
  - Also:
    - archived rows count toward `MAX_QUESTIONS`;
    - `duplicateSurvey` copies archived rows as live ones.
- [x] **H12 (CONFIRMED race): the optimistic-concurrency check is not atomic.**
  - Where: `app/lib/surveys.server.ts:630-645` and `:654-683`; publish at `:705-740`.
  - Defect: `assertRevision` compares a value read earlier, and the UPDATE is `where: { id }` with no revision condition.
  - Scenarios:
    - Two tabs at revision N both save: the second silently overwrites the first.
    - A draft save races a publish: publish commits the older draft and sets `draft: null`, destroying the newer one.
- [x] **H13 (CONFIRMED): unsaved Studio edits are discarded whenever a shopper answers.**
  - Where: `app/routes/app.surveys.$id.tsx:248-255`.
  - Defect: the editor resets local state when `dataKey` (`updatedAt:hasDraft:status`) changes. `Survey.updatedAt` moves on every shopper answer (`responseCount` increment).
  - Scenario: the merchant is editing a live survey, a shopper answers, and the merchant switches tab or language (which revalidates). All unsaved edits are discarded without warning.
- [x] **H14 (CONFIRMED): duplicating a survey with a show-if fails with a 500.**
  - Where: `app/lib/surveys.server.ts:794-815`.
  - Defect: `duplicateSurvey` strips ids but copies `showIf` pointing at the source survey's ids.
  - Scenario: Duplicate any survey with a show-if and get `show_if_unknown`, which becomes a 500.
  - Also:
    - it copies the draft view;
    - it drops `templateId`, `templateVersion`, `design`, `rotation` and `learnAndStop`, so the copy's presets are dead.

### Shopify sync and admin blocks

- [x] **H15 (CONFIRMED): the admin blocks can never load data.**
  - Where: `app/routes/api.admin-survey-context.tsx:33-43`.
  - Defect: the OPTIONS response sets only `Access-Control-Allow-Origin`, with no `Access-Control-Allow-Headers: Authorization, Content-Type`. The block's POST (`extensions/shared/src/admin-response-block.tsx:67-71`) sends both non-safelisted headers.
  - Scenario: the browser rejects the preflight, so the order and customer admin blocks always show "No survey answer recorded".
- [x] **H16 (CONFIRMED): concurrent drains can fire Flow twice.**
  - Where: `app/lib/sync.server.ts:541-547` and `:563-574`.
  - Defect: `processPendingSync` reads rows with a plain `findMany`, with no claim, lease or `SKIP LOCKED`.
  - Scenario: two buyers submit together. `answers.server.ts:287` drains inline on both requests, so both process the same `flow` rows and the merchant's workflow runs twice (duplicate emails or discounts). The loser's `delete` hits P2025 and abandons the rest of the batch.
- [x] **H17 (CONFIRMED): `app/scopes_update` never updates the stored scope.**
  - Where: `app/lib/webhooks.server.ts:319-323`.
  - Defect: the handler only logs and never updates `Session.scope`, and nothing else writes that column. An active offline session is never re-exchanged.
  - Readers of the stale value: `sync.server.ts:555-558`, `app.settings.tsx:53`, `app.surveys.$id.tsx:111`, `app.surveys.library.$id.setup.tsx:113`.
  - Scenario: a merchant installed with `read_orders`, then approves the write scopes. `canSync` stays false forever, sync is skipped, and Settings keeps saying the scopes are missing. If scopes are reduced instead, writes are attempted and fail until `MAX_SYNC_ATTEMPTS`.

### Billing

- [x] **H18 (CONFIRMED race): a paying merchant can drop to Free after an upgrade.**
  - Where: `app/lib/webhooks.server.ts:537-545`; also `app/routes/app.plans.tsx:91`.
  - Defect: the "superseded subscription" guard is a read followed by an unconditional `setPlan`.
  - Scenario: the merchant upgrades Growth (A) → Scale (B), and the A CANCELLED and B ACTIVE notices are processed concurrently.
    1. A CANCELLED reads `gid = A`.
    2. B ACTIVE writes Scale.
    3. A CANCELLED then writes (growth, cancelled).
  - Result: the merchant pays for Scale but `effectivePlan` is Free, and answers get locked.

### Uninstall, GDPR and retention

- [x] **H19 (CONFIRMED): a deferred `customers/redact` can miss Shopify's 30-day deadline.**
  - Where: `app/lib/compliance.server.ts:267-273`; callers only `app/routes/app._index.tsx:52` and `app.dashboard.tsx:60`.
  - Defect: deferred redact batches drain only when that merchant opens Home or Dashboard. The 5-minute throttle is one module-level timestamp shared by all shops.
  - Scenario: a redact names 450 orders, so 250 are deferred. If the merchant does not open the app for 30+ days, those Responses, Answers (including free text), legacy rows and `OrderCache` outlive the deadline. A visit by any other shop in the previous 5 minutes also makes this shop's drain skip.
- [x] **H20 (PLAUSIBLE): a late `shop/redact` can wipe a reinstalled shop.**
  - Where: `app/lib/compliance.server.ts:303-314`.
  - Defect: `handleShopRedact` deletes Sessions and the Shop row (cascading everything) without checking `installState` or `uninstalledAt`.
  - Scenario: the merchant uninstalls, reinstalls within 48h, and a `shop/redact` for the old install still arrives (or a late retry). All new surveys, responses and orders are deleted, along with the live session.

---

## Medium

### Survey submission

- [x] **M1 (CONFIRMED): stale answers on hidden questions get the submission rejected.**
  - Where: `extensions/shared/src/use-multi-survey.ts:41-59` and `:213`, versus `shared/survey-rules.ts:666`.
  - Defect: the extension's visibility check reads answers left on questions that are now hidden.
  - Scenario: Q2 shows if Q1=a, and Q3 shows if Q2=x. The buyer answers Q1=a, Q2=x and Q3, then changes Q1 to b. The extension still sends Q3, the server returns `hidden_answered` (400), and the answer is lost.
- [x] **M2 (CONFIRMED): the client completeness check misses rules the server enforces.**
  - Where: `extensions/shared/src/use-multi-survey.ts:269-285`.
  - Defect: `complete` never checks multi-choice "Other" text, `minSelections` or `maxSelections`.
  - Scenario: Submit is enabled, the server rejects with `other_required`, `min_selections` or `max_selections` (400), and the answer is lost.
- [x] **M3 (CONFIRMED; token reuse across retries is PLAUSIBLE): failed attempts burn the per-token submit cap.**
  - Where: `app/routes/api.survey-responses.tsx:106`; `app/lib/rate-limit.server.ts:183-201`.
  - Defect: the per-token cap of 2 is consumed before any other check, and failed attempts count against it.
  - Scenarios:
    - Two 5xx responses while Neon wakes, then every retry gets 429 until the 5-minute token expires, which outlasts the 60s budget, so the answer is lost.
    - The backstop refuses attempts 1–2 before the order lands. Attempt 3 still gets the token-cap 429, so the "known orders always pass" exemption never helps.
- [x] **M4 (CONFIRMED): one order can be answered twice across the two surfaces.**
  - Where: `prisma/schema.prisma:426`, `app/routes/api.survey.tsx:84`, `shared/survey-config.ts:195` and `:295`.
  - Defect: the unique key is (shop, survey, order), but thank-you and order-status can resolve to different surveys (payment and first-order targeting apply only on thank-you), and `alreadyAnswered` is a check-then-act read.
  - Scenario: thank-you and order-status are open together. Two Responses are written for one order, and usage and `responseCount` are double-incremented.
- [x] **M5 (CONFIRMED): duplicate and off-type answer fields are stored unvalidated.**
  - Where: `app/lib/answers.server.ts:225` versus `shared/survey-rules.ts:652`.
  - Defect: validation keeps only the last answer per `questionId`, but every element is stored. Fields foreign to the question type are also stored.
  - Scenario: a forged body `[{questionId:Q1, optionIds:["junk"]}, {questionId:Q1, optionIds:[valid]}]` passes validation and stores the junk row. This skews learn-and-stop.
- [x] **M6 (CONFIRMED): an edit or publish loses answers already in flight.**
  - Where: `app/routes/api.survey-responses.tsx:122-139` (config cache at `surveys.server.ts:901-926`).
  - Defect: buyers answer against a config cached for up to 60s, but the submit is validated against the current definition.
  - Scenario: the merchant removes an option or adds a required question. In-flight answers fail with `unknown_option` or `required` (400) and are lost.
- [x] **M7 (CONFIRMED): omitting `orderId` skips the backstop and the duplicate guard.**
  - Where: `app/routes/api.survey-responses.tsx:59` and `:111`.
  - Defect: `orderId` is optional, and NULL order ids are distinct in the unique index.
  - Scenario: a buyer token posts without `orderId` and writes unlimited rows, limited only by a shared bucket of about 10/min. This poisons reports and burns the Free cap.

### Order webhooks

- [x] **M8 (CONFIRMED): a near-simultaneous newer update can be dropped as stale.**
  - Where: `app/lib/webhooks.server.ts:447-449` and `:453`.
  - Defect: when the guarded `updateMany` matches nothing and `create` hits P2002, the code assumes a newer row exists and returns `order_stale_ignored` with 200, without re-running the guarded update.
  - Scenario: `orders/create` (T1) and `orders/cancelled` (T2 > T1) arrive within milliseconds. The cancellation is lost, and the cancelled order counts as revenue. The same race exists between backfill and a webhook.
- [x] **M9 (CONFIRMED): v2 shows a total frozen at first reconcile.**
  - Where: `app/lib/answers.server.ts:464`, `app/routes/app.results_.csv.tsx:98-101` and `app/routes/app.responses.tsx:88-91`.
  - Defect: `Response.orderTotal` is only filled when null and is never updated. The revenue decision reads the live `OrderCache` instead.
  - Scenario: a $100 order is refunded down to $60. The CSV and Responses page show 100.00 "counted", while Results counts 60.

### Uninstall, GDPR and retention

- [x] **M10 (PLAUSIBLE): a late `app/uninstalled` wipes a reinstalled, paying shop.**
  - Where: `app/lib/webhooks.server.ts:306-316` and `app/lib/shop.server.ts:177-195`; `triggeredAt` is dropped at `app/routes/webhooks.tsx:35`.
  - Defect: the uninstall is applied with no ordering check.
  - Scenario: the first uninstall delivery times out on a cold start. The merchant reinstalls and subscribes, then the retry lands. It:
    - deletes the new sessions;
    - nulls the token;
    - sets `plan: free` and clears `subscriptionGid`.
  - Result: until the next admin visit, all `orders/*` webhooks and billing notices are ignored, and the merchant stays capped at Free while paying.
- [x] **M11 (CONFIRMED): retention silently drops unfinished redacts.**
  - Where: `app/lib/retention.server.ts:126-128`.
  - Defect: retention deletes `PendingDeletion` rows after 24 months instead of executing them.
  - Scenario: an unfinished redact (see H19) is discarded, never run, and nothing alerts.
- [x] **M12 (CONFIRMED that `orderIds` is unused; the payload shape is PLAUSIBLE): the customer data request reports nothing.**
  - Where: `app/routes/webhooks.tsx:136-142` and `app/lib/compliance.server.ts:51` and `:63-68`.
  - Defect: `customers/data_request` ignores the payload's `orders_requested`, and `handleDataRequest`'s `orderIds` is never used. The stored summary (`:94-102`) says no records are attributable to the individual.
  - Scenario: Response and Answer rows for those orders (free text included) exist but are not reported, so the merchant gets an incorrect data-request answer.

### Billing

- [x] **M13 (PLAUSIBLE): stale ACTIVE or out-of-order notices are applied.**
  - Where: `app/lib/webhooks.server.ts:536-545`.
  - Defect: ACTIVE notices are never compared with the stored gid or with `updated_at`.
  - Scenarios:
    - A Growth (A) ACTIVE retry lands after the move to Scale (B) and sets Growth. A's later CANCELLED then matches and moves the merchant to Free.
    - A PENDING or FROZEN notice for the same gid arriving after ACTIVE caps a paying merchant.
- [x] **M14 (PLAUSIBLE): the webhook's test-charge guard probably never fires.**
  - Where: `app/lib/webhooks.server.ts:560` (type at `:494`).
  - Defect: `isIgnoredTestCharge` reads `payload.test`, which `app_subscriptions/update` likely does not carry.
  - Scenario: a staging build sharing the client id approves a test charge on a live store. Production grants Growth for free until the Plans page is opened.
- [x] **M15 (PLAUSIBLE): review and development stores may never reach a paid plan.**
  - Where: `app/lib/billing.server.ts:104` and `:228`.
  - Defect: `test` derives only from `NODE_ENV`, with no development-store detection.
  - Scenario: App Store review installs on a dev store and cannot complete a paid plan. Either Shopify rejects a real charge on the dev store, or the test charge is rejected by `paidPlanFromSubscriptions`.

### Shopify sync and admin blocks

- [x] **M16 (CONFIRMED in code; `iss` absence on checkout tokens is PLAUSIBLE): checkout session tokens pass admin ID-token verification.**
  - Where: `app/lib/id-token.server.ts:158-170`.
  - Defect: only alg, HMAC, `exp`/`nbf` and `aud` are checked. `iss` (`https://<shop>/admin`) is not checked, nor is `iss` matched against `dest`.
  - Scenario: a buyer takes their own checkout or customer-account session token, POSTs `{orderId: N}` to `/api/admin-survey-context` for a range of N, and reads other buyers' answers, including free text. There is no rate limit.
- [x] **M17 (CONFIRMED): customer writes are dropped on transient errors.**
  - Where: `app/lib/sync.server.ts:318-323` (callers `:417-418`, `:469-470`).
  - Defect: `fetchOrderCustomerId` swallows all errors and returns null, and a null is treated as "no customer → success".
  - Scenario: an inline thank-you sync runs before the order exists, or hits a timeout or 5xx. The customer tags and metafields are lost permanently.
- [x] **M18 (CONFIRMED): process-wide sweep throttles starve other shops.**
  - Where: `app/lib/sync.server.ts:604-610` and `app/lib/compliance.server.ts:267-273`.
  - Defect: one module-level timestamp throttles every shop's sweep.
  - Scenario: shop A's visit consumes the 5-minute slot, so shops B…N's pending sync and deferred redacts are skipped on their visits.
- [x] **M19 (CONFIRMED): the buyer's submit waits on Shopify writes.**
  - Where: `app/lib/answers.server.ts:287`.
  - Defect: `await processPendingSync(shopId, 5)` runs inline in the buyer's submit request, including other responses' rows.
  - Scenario: a throttled shop or revoked token. Each submit waits up to 5 × (20s timeout or 4 retries), which exceeds the extension's 60s budget and triggers duplicate-submit retries.
- [x] **M20 (PLAUSIBLE): non-idempotent mutations are retried.**
  - Where: `app/lib/shopify-graphql.server.ts:46`, `:93-94` and `:117-122`.
  - Defect: 5xx and `INTERNAL_SERVER_ERROR` are retried up to 4 times for every operation, including `flowTriggerReceive` and `appSubscriptionCreate`.
  - Scenario: Shopify processes the trigger but returns 502. Flow runs up to 4 times, or duplicate pending charges are created.

### Survey editor

- [x] **M21 (CONFIRMED): a show-if can point at an unsaved option and never match.**
  - Where: `app/components/survey-editor.tsx:566-571` → `app/lib/surveys.server.ts:427`.
  - Defect: a show-if can reference a new option with id `""`, and `optionIds: [""]` is persisted literally.
  - Scenario: add option "TikTok" and, in the same edit, make Q2 show if Q1 = TikTok. Q2 never shows.
- [x] **M22 (CONFIRMED): discard ignores the posted revision.**
  - Where: `app/routes/app.surveys.$id.tsx:145-146` and `app/lib/surveys.server.ts:751-755`.
  - Scenario: Discard from a stale tab wipes a newer draft.
- [x] **M23 (CONFIRMED): one active survey can starve another.**
  - Where: `app/lib/surveys.server.ts:375` and `:573` (selection `api.survey.tsx`).
  - Defect: all surveys are created with `priority: 0`, and ties are broken by `updatedAt desc`, which moves on each answer.
  - Scenario: two active Thank-you surveys. The one with the latest answer wins forever.
- [x] **M24 (CONFIRMED): the active-survey limit is never enforced.**
  - Where: `app/lib/surveys.server.ts:758-780`, with `app/routes/app.surveys.$id.tsx:306` and `app.surveys.library.$id.setup.tsx:259`.
  - Defect: `MAX_ACTIVE_SURVEYS` is never checked, and `overActiveLimit: false` is hard-coded.
  - Scenario: activating up to 50 surveys can exceed `MAX_COMPILED_CONFIG_BYTES`, which is only logged.
- [x] **M25 (CONFIRMED): survey fields are saved with no server-side validation.**
  - Where: `app/lib/surveys.server.ts:660`, `:667-669`, `:675`, `:721` and `:728-734`.
  - Defect: placements, targeting, design, translations, `syncOptions` and `rotationWeight` are mass-assigned from the posted JSON. The limits are client-only.
  - Scenarios:
    - unknown or flag-disabled placements are stored;
    - 10 KB labels are shipped to checkout;
    - `samplePercent ≤ 0` hides the survey forever;
    - a non-integer `rotationWeight` causes a Prisma error and a 500.
- [x] **M26 (CONFIRMED): publish and save skip the activation guards.**
  - Where: `app/lib/surveys.server.ts:716-742` and `:658`.
  - Defect: publish does not re-run `no_placements`, and a draft save can set `status` straight from the input.
  - Scenario: untick every placement on a live survey and publish. It stays "active" but shows nowhere.
- [x] **M27 (CONFIRMED): expected validation and not-found errors become generic 500s.**
  - Where: `app/routes/app.surveys.$id.tsx:155-156`, `app.surveys._index.tsx:58,114,131` and `app.surveys.library.$id.setup.tsx:152-157`.
  - Defect: `ValidationError` and `NotFoundError` are thrown out of actions.
  - Scenario: activating with no placements, hitting the survey limit, an unknown template, or a survey deleted in another tab all show the 500 page.
- [x] **M28 (PLAUSIBLE): editing an answered question reinterprets its history.**
  - Where: `app/lib/surveys.server.ts:438-463`.
  - Defect: a question can change `type`, and an option can be relabelled, while keeping its id.
  - Scenario: change Q1 from `single_choice` to `nps`, or rename "Instagram" to "TikTok". Historical answers are reinterpreted.
- [x] **M29 (CONFIRMED): Overview and Results read the draft structure.**
  - Where: `app/routes/app.surveys.$id.tsx:95`.
  - Defect: insights are built from the draft view, not the published one.
  - Scenario: a draft that deletes a question hides that question's results until publish.

### Reporting

- [x] **M30 (CONFIRMED that it is unbounded; OOM is PLAUSIBLE): Results load every response into memory.**
  - Where: `app/routes/app.results.tsx:47`, `app/routes/app.results_.csv.tsx:74` and `app/lib/survey-analytics.server.ts:88`.
  - Defect: all responses and answers are loaded with no limit, and the order lookup uses an unbounded `IN (...)`.
  - Scenario: about 48k responses on a 512 MB instance makes the loader slow or OOM.
- [x] **M31 (CONFIRMED): admin pages block on inline Shopify calls.**
  - Where: `app/lib/order-backfill.server.ts:132-137` and `app/lib/shopify-graphql.server.ts:82`.
  - Defect: backfill runs inline in five loaders: up to 10 sequential calls with a 20s timeout and 4 retries on 429/5xx.
  - Scenario: when Shopify is slow, admin pages block for minutes.
- [x] **M32 (CONFIRMED): rows that will never resolve show as "Pending" forever.**
  - Where: `app/lib/survey-analytics.server.ts:323`.
  - Defect: "Pending" is `orderTotal === null`, which includes order-less (on-site/link) and `unverifiedFailed` rows.
  - Scenario: those rows show "Pending" forever.
- [x] **M33 (PLAUSIBLE): the response rate can exceed 100%.**
  - Where: `app/lib/analytics-queries.server.ts:327` versus `:156`.
  - Defect: the numerator counts by `submittedAt`, the denominator by order `createdAtShop`.
  - Scenario: order-status answers given days later push the rate over 100% on 7-day windows.
- [x] **M34 (CONFIRMED): multi-choice revenue is credited in full to every option.**
  - Where: `app/lib/survey-analytics.server.ts:267-275`.
  - Scenario: Instagram + TikTok on a $100 order credits each with $100. Per-option totals exceed the survey total with no disclosure.

---

## Low

### Install, auth and session

- [x] **L1 (CONFIRMED): a webhook can resurrect an uninstalled shop.**
  - Where: `app/lib/webhooks.server.ts:49-55` with `app/lib/shop.server.ts:85-86`; the same pattern is in `app/lib/provision.server.ts:69-71`.
  - Defect: `resolveInstalledShop` checks `installState`, then `upsertShop` unconditionally sets `installed` and writes the token.
  - Scenario: an `orders/updated` delivery runs concurrently with `app/uninstalled`. The shop is flipped back to installed with the revoked token stored, and after `shop/redact` the Shop row is recreated.
- [ ] **L2 (CONFIRMED): a failed plan lookup erases known checkout support.**
  - Where: `app/lib/provision.server.ts:44-46` with `app/lib/shopify-rest.server.ts:464-470`.
  - Defect: `fetchShopPlanName` swallows errors and returns null, so `setCheckoutSupport(null)` overwrites a known true/false and stamps `checkoutCheckedAt`.
  - Scenario: a 5xx during reinstall makes a Starter shop lose its "plan blocked" banner.
- [ ] **L3 (CONFIRMED): legacy Session tokens stay plaintext.**
  - Where: `app/session-storage.server.ts:19-20` and `:30-31`.
  - Defect: legacy plaintext tokens are claimed to be re-encrypted "on the next store", but non-expiring offline sessions are never re-stored.
- [ ] **L4 (CONFIRMED): token decryption failures are silent, and key rotation is all-or-nothing.**
  - Where: `app/lib/sync.server.ts:551-553` and `app/session-storage.server.ts:37`.
  - Defect: an undecryptable or missing token returns `{done:0, failed:0}` with no log, and the decrypt-failure log has no context. `enc:v1:` has no key id.
  - Scenario: rotating `TOKEN_ENCRYPTION_KEY` invalidates every token at once, and background work stalls silently.
- [ ] **L5 (CONFIRMED): the post-auth redirect drops the embedded parameters.**
  - Where: `app/routes/auth.$.tsx:23-24`.
  - Defect: the redirect to `/app` drops `shop`, `host` and `embedded`, which causes an extra App Bridge bounce. There is no `/auth/login` route, so `/auth/login` returns the library's 500.
- [ ] **L6 (CONFIRMED): the first page load after install waits on two Admin API calls.**
  - Where: `app/shopify.server.ts:27-29` and `app/lib/provision.server.ts:28-46`.
  - Defect: `afterAuth` makes two sequential Admin calls, each with a 20s timeout and retries, and an exception becomes a bare 500.
  - Scenario: the first load after install blocks for 40s+ when Shopify is slow.
- [ ] **L7 (CONFIRMED): a placeholder shop id is never corrected.**
  - Where: `app/lib/provision.server.ts:27-37` and `app/lib/shop.server.ts:74`.
  - Defect: if the identity query fails on first provision, `Shop.shopId` (unique) is set to the domain instead of the GID, and it is never corrected while the token stays valid. The impact is latent.
- [ ] **L8 (PLAUSIBLE): a slow database at boot can disable session storage.**
  - Where: `app/session-storage.server.ts:79`.
  - Defect: `PrismaSessionStorage` polls for the table twice at module load. If the DB is unreachable then, the stored rejected `ready` promise either crashes the process or makes every session call throw until restart.
- [ ] **L9 (PLAUSIBLE): parallel first loads can hit P2002.**
  - Where: `app/lib/shop.server.ts:54` and `app/db.server.ts:57`.
  - Defect: parallel first-load `ensureShop` → `provisionShop` can hit P2002 if Prisma does not use a native upsert, and P2002 is not retryable. Each parallel loader also duplicates the GraphQL calls.

### Survey submission

- [x] **L10 (CONFIRMED): the shop backstop locks out real buyers whose order is not cached yet.**
  - Where: `app/lib/rate-limit.server.ts:50` and `:129`.
  - Defect: under abuse, the backstop refuses real buyers whose order is not cached yet, which is the normal thank-you timing.
  - Scenario: they get 429 for 60s, and the answer is lost.
- [x] **L11 (CONFIRMED): retries and swallowed errors bypass usage counting and sync.**
  - Where: `app/lib/answers.server.ts:248`.
  - Defect: a failure in `claimUsageSlot` is only logged, so the answer is neither counted nor flagged, bypassing the cap.
  - Scenario: a retry after a committed-but-dropped insert takes the duplicate path, which skips usage, `responseCount` and sync.
- [x] **L12 (CONFIRMED): a failed counter bump leaves the answer half-processed.**
  - Where: `app/lib/answers.server.ts:256`.
  - Defect: if `bumpSurveyResponseCount` throws after commit, the buyer gets a 500 and the retry returns "duplicate".
  - Scenario: that answer's learn-and-stop check and sync enqueue never run.
- [x] **L13 (CONFIRMED): the learn-and-stop pause is served stale.**
  - Where: `app/lib/answers.server.ts:385`.
  - Defect: the pause does not call `invalidateConfig`, so the paused survey is still served for 60s, and `maxResponses` uses the cached count.
- [x] **L14 (CONFIRMED): response-body errors are mishandled.**
  - Where: `extensions/shared/src/survey-logic.ts:277`.
  - Defect: `response.json()` runs after the attempt timer is cleared and its errors are not transient.
  - Scenarios:
    - a stalled body leaves the block stuck on "sending";
    - a 200 with a non-JSON body is logged as `survey_submit_lost` although it was committed.
- [x] **L15 (PLAUSIBLE): a throwing host getter crashes the block.**
  - Where: `extensions/shared/src/survey-logic.ts:356`.
  - Defect: `getPaymentTypes` is not wrapped in `safeRead`.
  - Scenario: the host getter throws, and the block crashes in the effect.
- [x] **L16 (CONFIRMED): text fields do not show their stored value.**
  - Where: `extensions/shared/src/MultiSurveyView.tsx:270-296` (with `use-multi-survey.ts:196-197`).
  - Scenarios:
    - Back/Next in one-by-one mode shows an empty field while the old text is still submitted;
    - abandoned "Other" text is still stored on the chosen option (`answers.server.ts:231`).
- [x] **L17 (CONFIRMED): first-order targeting never matches on order-status.**
  - Where: `shared/survey-config.ts:195-196`.
  - Defect: order-status never sends `isFirstOrder`.
  - Scenario: first-order and returning-customer targeting never matches there, despite the comment at `survey-logic.ts:219-225`.
- [x] **L18 (CONFIRMED): any order id from the store can be answered.**
  - Where: `app/routes/api.survey-responses.tsx:122`.
  - Defect: no survey status, placement or targeting check is made, and `orderId` is not bound to the token.
  - Scenario: a buyer answers another order id first, which hides the survey from the real buyer (`alreadyAnswered`). Paused surveys can also be answered. Data never crosses shops.

### Order webhooks

- [x] **L19 (CONFIRMED): the ledger re-claim does not refresh `error` or `createdAt`.**
  - Where: `app/lib/webhooks.server.ts:175-188`.
  - Scenario: two concurrent retries of a failed delivery both re-claim, and after 5 minutes every duplicate counts as abandoned.
- [x] **L20 (CONFIRMED): ledger claim errors escape the route's handling.**
  - Where: `app/lib/webhooks.server.ts:146` and `app/routes/webhooks.tsx:48`.
  - Defect: `claimWebhook`'s insert has no `retryDb` and sits outside the route's try.
  - Scenario: a Neon wake produces an unlogged framework 500.
- [x] **L21 (PLAUSIBLE): two updates within the same second can apply out of order.**
  - Where: `app/lib/webhooks.server.ts:432`.
  - Defect: the guard is `updatedAtShop lte updatedAt`, and Shopify's `updated_at` has one-second precision.
  - Scenario: two updates in the same second arrive reversed, and the older one wins.
- [x] **L22 (CONFIRMED): unsupported-plan shops trigger a plan query on every order webhook.**
  - Where: `app/lib/webhooks.server.ts:60`.
  - Defect: `refreshCheckoutSupport` fires a GraphQL plan query on every order webhook for shops whose support is false or unknown.
- [x] **L23 (PLAUSIBLE): money parsing rejects rather than rounds.**
  - Where: `app/lib/money.ts:79` (table at `:23-26`).
  - Defect: a fractional amount for a currency listed as zero-decimal (e.g. ISK "1990.50") is rejected.
  - Scenario: `totalPrice` is NULL and every answer for that shop stays Pending.
- [x] **L24 (CONFIRMED): the backfill selects by answer date, not order date.**
  - Where: `app/lib/order-backfill.server.ts:113`.
  - Defect: the age window uses the answer date.
  - Scenario: an order outside `read_orders`' 60-day window is retried every hour and fails each time.

### Uninstall, GDPR and retention

- [x] **L26 (CONFIRMED): webhook retries duplicate `PendingDeletion` and `DataRequest` rows.**
  - Where: `app/lib/compliance.server.ts:166-176` and `:107-115`.
  - Defect: the `PendingDeletion` row is created before the inline batch, and the `DataRequest` row is created on every delivery.
  - Scenario: a retry duplicates both. The deletes are idempotent.
- [x] **L27 (PLAUSIBLE): a submit during a redact orphans a PendingSync row.**
  - Where: `app/lib/compliance.server.ts:200-206`.
  - Defect: a submit landing between the `findMany` and `deleteMany` orphans its PendingSync row, and there is no FK to cascade it.
- [x] **L28 (PLAUSIBLE): a redacted order can be written again.**
  - Where: `app/lib/webhooks.server.ts:266-274`.
  - Defect: nothing blocks re-creation. A later `orders/updated` recreates its `OrderCache`, and the buyer can answer it again.
- [x] **L30 (PLAUSIBLE): redaction never adjusts daily stats.**
  - Where: `app/lib/compliance.server.ts:193-208`.
  - Defect: `SurveyDailyStats` backfilled rows can map to one order's channel and total.
  - Related: the retention comment at `retention.server.ts:89-91` wrongly claims these rows cascade.
- [x] **L31 (CONFIRMED): retention ages `OrderCache` by cache date, not order date.**
  - Where: `app/lib/retention.server.ts:133`.
  - Scenario: a 3-year-old backfilled order is kept 24 more months.
- [x] **L32 (CONFIRMED): there is no backstop when `shop/redact` never arrives.**
  - Where: `app/lib/retention.server.ts:58-166`.
  - Scenario: a shop uninstalled more than 48h ago whose `shop/redact` never arrived keeps its data for 24 months, and its Shop row forever.

### Billing

- [x] **L33 (CONFIRMED): the Plans page can show a plan that is not enforced.**
  - Where: `app/routes/app.plans.tsx:77` versus `:91-98`.
  - Defect: the displayed plan is assigned before `setPlan`, and a failed write is only logged.
  - Scenario: the page shows Growth while Free is enforced.
- [x] **L34 (PLAUSIBLE): an empty answer downgrades a paying merchant.**
  - Where: `app/lib/billing.server.ts:196`.
  - Defect: a null `appInstallation` is treated as "no subscriptions".
  - Scenario: the loader writes Free/expired for a paying merchant.
- [x] **L35 (PLAUSIBLE): a missing confirmation URL is reported as success.**
  - Where: `app/routes/app.plans.tsx:191-193`.
  - Defect: `confirmationUrl: null` returns a success banner although nothing can be approved.
- [x] **L36 (CONFIRMED): cancel and display filter subscriptions differently.**
  - Where: `app/lib/billing.server.ts:205-216` versus `:226-239`.
  - Defect: `activeSourceTracSubscription` does not skip test charges, while `paidPlanFromSubscriptions` does.
  - Scenario: a leftover test subscription id is stored or cancelled instead of the billed one.
- [x] **L37 (CONFIRMED): two usage counters use different rules.**
  - Where: `app/lib/answers.server.ts:125` and `:139` versus `app/lib/responses.server.ts:47-49`.
  - Defect: the v2 counter stops at the cap, while the legacy counter is unlimited, and both write one `BillingUsage` row.
  - Scenario: the displayed usage is frozen at 50/50 or jumps past it.
- [x] **L38 (PLAUSIBLE): the legacy counter can lose increments.**
  - Where: `app/lib/responses.server.ts:41-45`.
  - Defect: the upsert can race on P2002, which is not retryable, and the failure is only logged.
  - Scenario: a lost increment lets one extra answer through unlocked.
- [x] **L39 (PLAUSIBLE): a retried write can double-count usage.**
  - Where: `app/lib/answers.server.ts:105-127`.
  - Defect: `claimUsageSlot` runs inside `retryDb`, so a committed-but-dropped UPDATE (P1017) is incremented twice.
  - Scenario: a Free shop hits the cap early.

### Shopify sync and admin blocks

- [x] **L40 (CONFIRMED): poison rows are never cleared or shown.**
  - Where: `app/lib/sync.server.ts:543` and `:579`.
  - Defect: rows at `MAX_SYNC_ATTEMPTS` are never cleared or surfaced, and backoff caps at about 32s.
  - Scenario: any permanent userError leaves a stuck row the merchant never sees.
- [x] **L41 (PLAUSIBLE): a newline in a buyer's answer breaks the whole metafield write.**
  - Where: `app/lib/sync.server.ts:447` and `:476`.
  - Defect: free text with a newline goes into a `single_line_text_field`.
  - Scenario: the whole atomic `metafieldsSet` fails, order metafield included, and the row is poisoned.
- [x] **L42 (CONFIRMED): metafield types and fields are not validated.**
  - Where: `app/lib/sync.server.ts:487` and `:81-83`.
  - Defect: numeric preset values are written as `single_line_text_field`, and merchant namespace, key and type are not validated.
  - Scenario: a merchant-defined `number_integer` definition makes every write fail.
- [x] **L43 (CONFIRMED): an empty tag is written when the channel is unanswered.**
  - Where: `app/lib/sync.server.ts:399` and `:420`.
  - Defect: an empty channel produces the tag `sourcetrac:`, and only the first `{channel}` is replaced.
- [x] **L44 (CONFIRMED): the buyer controls part of a tag.**
  - Where: `app/lib/sync.server.ts:256` and `:399`.
  - Defect: the buyer's free-text "Other" answer becomes the tag suffix, and colons survive sanitising.
  - Scenario: `sourcetrac:wholesale:approved` drives a merchant Flow.
- [x] **L45 (CONFIRMED): the Flow `Channel` field carries an internal id.**
  - Where: `app/lib/sync.server.ts:255` and `:509`.
  - Defect: `Channel` is a raw option cuid.
  - Scenario: a merchant condition `Channel == instagram` never matches for new surveys.
- [x] **L46 (CONFIRMED): tokens without `exp` never expire.**
  - Where: `app/lib/id-token.server.ts:161-163`.
  - Defect: `exp` and `nbf` are optional, so a token without `exp` never expires (compounds M16).
- [x] **L47 (CONFIRMED): the customer block misses older orders and hides its failures.**
  - Where: `app/lib/admin-survey-context.server.ts:88` and `:123-125`.
  - Defect: only the 20 latest orders within the 60-day `read_orders` window are read, and the catch swallows the error with no log.
- [x] **L48 (CONFIRMED): the admin block can spin forever.**
  - Where: `extensions/shared/src/admin-response-block.tsx:61`.
  - Defect: `await getToken()` is outside the try/finally.
  - Scenario: the block spins forever if `idToken()` rejects. The admin blocks also have no `locales/` folder.
- [x] **L49 (PLAUSIBLE): old pending writes fire after a reinstall.**
  - Where: `app/lib/sync.server.ts:551-553`.
  - Defect: pending rows survive uninstall.
  - Scenario: Flow triggers and tags fire for answers that are months old.
- [x] **L50 (CONFIRMED): nothing in the database prevents duplicate sync rows.**
  - Where: `prisma/schema.prisma:478-491` and `app/lib/sync.server.ts:137-149`.
  - Defect: `PendingSync` has no `@@unique([responseId, kind])`, and enqueue is check-then-insert.
  - Scenario: duplicate rows, and so duplicate Flow runs.

### Survey editor

- [x] **L51 (CONFIRMED): saving reverts a reorder.**
  - Where: `app/lib/surveys.server.ts:818-823` and `:659`.
  - Defect: reorder does not bump `revision`, and a save writes back the stale `priority`.
  - Scenario: reorder in the list, save in the Studio, and the reorder is reverted.
- [x] **L52 (CONFIRMED): saving without `design` double-encodes it.**
  - Where: `app/lib/surveys.server.ts:675`.
  - Defect: `JSON.stringify(input.design ?? existing.designJson)` double-encodes when `design` is absent. The editor always sends it.
- [x] **L53 (CONFIRMED): a corrupt draft makes publish throw.**
  - Where: `app/lib/surveys.server.ts:710-712`.
  - Defect: a corrupt or `"null"` draft throws a TypeError on publish, giving a 500.
- [x] **L54 (CONFIRMED, crafted payload only): an option can be moved under another question.**
  - Where: `app/lib/surveys.server.ts:442-456`.
  - Defect: an option id from another question is updated in place but keeps its original `questionId`.
- [x] **L55 (CONFIRMED): the Free-plan exclusive-option check is too loose.**
  - Where: `app/lib/surveys.server.ts:544-545`.
  - Defect: the grandfather check passes if any option anywhere in the survey is exclusive.
- [x] **L56 (PLAUSIBLE): a Free shop can unlock a paid template feature.**
  - Where: `app/lib/surveys.server.ts:670`.
  - Defect: `templateId` is mass-assignable, which bypasses the `byProduct` plan gate.
- [x] **L57 (CONFIRMED): parallel creates can exceed the survey limit.**
  - Where: `app/lib/surveys.server.ts:555-567`.
  - Defect: the survey-count limit is checked outside the transaction.
- [x] **L58 (CONFIRMED): an unknown intent saves the survey.**
  - Where: `app/routes/app.surveys.$id.tsx:124`.
- [x] **L59 (CONFIRMED): Pause and Activate silently drop unsaved edits.**
  - Where: `app/routes/app.surveys.$id.tsx:150-158` and `:321-326`.
  - Defect: both are enabled while the form is dirty and post no survey data.
- [x] **L60 (CONFIRMED): the setup wizard can crash or half-create a survey.**
  - Where: `app/routes/app.surveys.library.$id.setup.tsx:133` and `:180-183`.
  - Defect: `JSON.parse` is unguarded, and create plus activate are not atomic.
  - Scenario: a retry after a failed activation creates a duplicate survey.
- [x] **L61 (CONFIRMED, crafted POST only): the `use-template` action creates an orphan and fails.**
  - Where: `app/routes/app.surveys.library._index.tsx:126-130`.
  - Defect: it redirects with a survey id to a route that expects a template id, leaving an orphan draft and a 500.
- [x] **L62 (CONFIRMED): a never-published draft can be paused.**
  - Where: `app/routes/app.surveys._index.tsx:109-115`.
- [x] **L63 (CONFIRMED): any loader error reads as "not found".**
  - Where: `app/routes/app.surveys.$id.tsx:70`.
  - Defect: `.catch(() => null)` turns a DB outage into "survey does not exist".
- [x] **L64 (CONFIRMED): the Studio title cache never evicts.**
  - Where: `app/lib/studio.server.ts:31-57`.
  - Defect: `titleCache` is never evicted, and a transient failure is cached for 10 minutes.

### Reporting

- [x] **L65 (CONFIRMED): a crafted page number causes a 500.**
  - Where: `app/routes/app.responses.tsx:39`.
  - Defect: `page` is not floored or capped.
  - Scenario: `?page=1.01` or a huge value raises a Prisma error, giving a 500.
- [x] **L66 (CONFIRMED): Responses times render in the server's zone.**
  - Where: `app/routes/app.responses.tsx:84`.
  - Defect: dates use the server zone with no label, while the CSV uses the shop zone.
- [x] **L67 (CONFIRMED): Pending rows are labelled "Not counted".**
  - Where: `app/routes/app.responses.tsx:163`.
  - Defect: the computed reason is never shown.
- [x] **L68 (CONFIRMED): abandoned rows are exported as "awaiting order".**
  - Where: `app/routes/app.results_.csv.tsx:35`.
  - Defect: `unverifiedFailed` rows are exported as "awaiting order".
- [x] **L69 (CONFIRMED): truncated exports look complete.**
  - Where: `app/routes/app.export.tsx:77-88` and `app/routes/app.export_.csv.tsx:191` and `:202`.
  - Defects:
    - the truncation header is ignored by the client;
    - the newest-first limit drops the oldest rows;
    - exactly 50,000 rows is flagged as truncated.
- [x] **L70 (CONFIRMED): a failed results CSV download is swallowed silently.**
  - Where: `app/routes/app.results.tsx:121`.
- [x] **L71 (CONFIRMED): unreconcilable rows wait forever.**
  - Where: `app/lib/analytics.ts:130`.
  - Defect: Dashboard "pending" includes `unreconcilable` rows, which then show "waiting for order" forever.
- [x] **L72 (CONFIRMED): Home makes uncached blocking calls.**
  - Where: `app/routes/app._index.tsx:71` and `app/lib/home.server.ts:50-57`.
  - Defect: every Home load makes an uncached blocking Shopify call and loads up to 3×5,000 responses sequentially.
- [x] **L73 (CONFIRMED): Home numbers are formatted and counted inconsistently.**
  - Where: `app/lib/home.server.ts:68` and `:79`.
  - Defects:
    - the average is not locale-formatted;
    - the badge count and the confidence `n` disagree;
    - NPS shows the 0–10 mean, not an NPS score.
- [x] **L74 (CONFIRMED): an older shop with no recent answers looks brand-new.**
  - Where: `app/routes/app.dashboard.tsx:95`.
  - Defect: `hasAnyResponse` is window-scoped.
  - Scenario: no answers in the last 30 days shows the "no answers yet" empty state.

---

## Info

- [x] **I2:** `markUnverifiedFailedResponses` (`app/lib/answers.server.ts:480-486`) has no `shopId` filter and no `orderId IS NOT NULL` filter. It runs only from `api.survey-config.tsx:84` (the legacy route), not on a dashboard visit as the project notes claim. It also flags order-less on-site/link answers. (CONFIRMED)
- [x] **I5:** `app/routes/app.dashboard.tsx:79` vs `:87`: two `new Date()` calls can straddle UTC midnight and shift the trend by a day. (PLAUSIBLE)
- [x] **I6:** `app/lib/compliance.server.ts:73-79`: the data-request channel breakdown reads only legacy `SurveyResponse`, while the total includes v2. (CONFIRMED)
- [ ] **I8:** `app/lib/crypto.server.ts:72`: `safeEqual` leaks the secret length. Also, `/readyz` (`app/routes/readyz.tsx:23`) shares `RETENTION_JOB_SECRET` with the data-deleting `/jobs/retention`. (CONFIRMED)
- [ ] **I9:** `app/routes/jobs.retention.ts:20-28`: an unset secret returns a distinctive `503 not_configured`, not the 404 its comment promises. (CONFIRMED)
- [x] **I11:** `app/lib/order-backfill.server.ts:83`: the `lastAttempt` map is never pruned. (CONFIRMED)
- [x] **I14:** `app/routes/api.survey-responses.tsx:139`: `surveyVersion` stores the current version, not the one the buyer answered. `productIds`, `country`, `isFirstOrder` and `customerId` are never sent or stored, so "results by product" is always empty. (CONFIRMED)
- [x] **I15:** `extensions/shared/src/survey-logic.ts:365` and `:394`: retry logs say "thank-you" on order-status, and `randomizeOptions` is never applied by the extension. (CONFIRMED)
- [ ] **I17:** `app/routes/api.survey.tsx:84`: `alreadyAnswered` checks only v2. A stale v1 client can answer the same order on both paths and count usage twice. (CONFIRMED)
- [x] **I18:** `shared/templates/smart-actions.ts:97-105`: the "first-order low rating" preset is not gated on first orders. (CONFIRMED)
- [x] **I19:** `app/lib/sync.server.ts:507-528`: Flow can fire before the order exists, so `order_reference` may not resolve. (PLAUSIBLE)
- [x] **I20:** Locked answers are never unlocked after an upgrade, and a duplicate submit on a now-paid shop still returns `counted: false` (`app/lib/answers.server.ts:326`, `responses.server.ts:164`). Uninstall records Free as `active` (`shop.server.ts:190-191`), while the Plans sync records it as `expired` (`app.plans.tsx:93`). `ACCEPTED` maps to `expired` (`webhooks.server.ts:591`). (CONFIRMED)
- [x] **I21:** `app/routes/app.plans.tsx:175-191`: re-choosing the current plan is not blocked server-side and `replacementBehavior` is unset, so duplicate pending charges are possible. (CONFIRMED)
- [ ] **I22:** `app/routes/app.tsx:107`: the shell loader sends the whole shop record (including `subscriptionGid`) to the browser. (CONFIRMED)
- [ ] **I24:** `app/routes/app.language.tsx:22`: the action is not wrapped in `guarded`. (CONFIRMED)
- [x] **I25:** `app/lib/surveys.server.ts:362`: an absent `revision` skips the concurrency check, so any client can bypass it. (CONFIRMED)
