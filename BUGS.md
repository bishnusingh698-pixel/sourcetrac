# SourceTrac bug audit (2026-10-20)

Read-only audit. No application code was changed. The previous audit (2026-10-15,
most items since fixed) is in git history: `git show HEAD:BUGS.md`.

Every finding names a file and line (line numbers as of this commit) and a
concrete scenario that triggers it. Confidence:

- **CONFIRMED**: the path was traced through the code.
- **PLAUSIBLE**: the finding depends on Shopify or runtime behaviour that could
  not be checked from this container (shopify.dev is blocked).
- **Re-verified** marks findings the coordinating reviewer re-checked by hand
  after the flow trace (code read or reproduced in node).

Findings come from eight end-to-end flow traces. Findings reported by more than
one trace are merged into one entry, and the entry lists every source.

| Tag | Flow |
| --- | --- |
| AUTH | install / OAuth / sessions / token lifecycle |
| SUBMIT | survey display and submission (checkout extensions + `/api/survey*`) |
| ORD | order webhooks, reconciliation, backfill |
| GDPR | app/uninstalled, GDPR webhooks, retention |
| BILL | billing and plan enforcement |
| SYNC | Shopify write-back (tags, metafields, Flow) and admin blocks |
| EDIT | survey creation and editing |
| REP | reporting and export |

**Totals:** 2 Critical, 4 High, 17 Medium, 49 Low, 27 Info.

---

## Step 1: API version, packages, GraphQL validation

### API version

| Where | Value |
| --- | --- |
| `shopify.app.toml:34` (webhooks `api_version`) | `2026-07` |
| All five `extensions/*/shopify.extension.toml` | `2026-07` |
| `app/lib/env.ts:36-38` (`SHOPIFY_API_VERSION`, pinned to the literal `API_VERSION`) | `2026-07` |
| `app/shopify.server.ts:24` (`shopifyApp({ apiVersion })`) | from env, `2026-07` |

**2026-10 is now the latest stable Admin API version**, and 2027-01 is the
release candidate. This comes from the toolkit's `supported-versions-schema.json`,
which supersedes the AGENTS.md note that "2026-10 is RC only". 2026-07 is still
supported, so this is not a bug today, but the app is one version behind. The
installed `@shopify/shopify-api` 15.0.0 already exports `ApiVersion.October26`.

### Packages (installed versus latest on npm, 2026-10-20)

| Package | Installed | Latest | Note |
| --- | --- | --- | --- |
| `@shopify/shopify-app-react-router` | 3.0.1 | 3.0.2 | Patch available. 3.0.1 also prints an unconditional `console.log('config.future.expiringOfflineAccessTokens', …)` on every token exchange (`dist/esm/server/authenticate/admin/strategies/token-exchange.mjs:16`). |
| `@shopify/shopify-api` (transitive) | 15.0.0 | 15.0.1 | Patch available. |
| `@shopify/shopify-app-session-storage-prisma` | 11.0.0 | 11.0.1 | Patch available. |
| `@shopify/shopify-app-session-storage` (transitive) | 7.0.0 | 7.0.1 | Patch available. |
| `@shopify/cli` (dev) | 4.8.3 | 4.9.4 | Minor available. It pulls in `global-agent` → `boolean@3.2.0`, which npm flags as deprecated. |
| `@shopify/ui-extensions` | 2026.7.4 | 2026.10.0 | Correctly matches `api_version = "2026-07"`. Move only together with the TOMLs. |
| `@shopify/polaris-types` | 1.1.0 | 1.1.0 | Current. |
| `react-router` / `@react-router/*` | 7.18.2 | 8.5.0 | Major behind; the exact pin is deliberate. |
| `prisma` / `@prisma/client` | 6.19.3 | 7.10.1 | Major behind. |
| `vite-tsconfig-paths` (dev) | 6.1.1 | — | Pulls in `tsconfck@3.1.6`, which npm flags as "unmaintained". |

None of the Shopify packages is deprecated. `@shopify/app-bridge-react` and
Polaris React are not used, which is correct.

### REST usage

There are **no REST Admin API calls**. Despite its name,
`app/lib/shopify-rest.server.ts` only runs GraphQL (`SourceTracPlan`). The two
non-GraphQL Shopify URLs are:

- `app/lib/shopify-graphql.server.ts:101`: the GraphQL endpoint, called with a
  hand-rolled `fetch`, not REST.
- `app/lib/token-migration.server.ts:32`: the OAuth token endpoint
  (`/admin/oauth/access_token`), not the REST Admin API.

The app does not configure `restResources`.

### GraphQL validation (Shopify AI Toolkit)

Tool: Shopify's `shopify-ai-toolkit`, cloned from GitHub. Its
`scripts/validate.mjs --api admin` validates against the Admin schema bundled
with the toolkit, offline, with telemetry turned off (`OPT_OUT_INSTRUMENTATION=true`).
The toolkit checks validity but does not report deprecations, so each
operation was also walked with `graphql-js` `TypeInfo` against the same bundled
schemas. That check was confirmed to flag a known deprecated field
(`ShopPlan.displayName`) before it was trusted.

All 16 operations are **VALID** on 2026-07, and also on 2026-10 and 2027-01,
with **no deprecated fields, arguments or enum values**:

| # | Operation | File |
| --- | --- | --- |
| 1 | `mutation SourceTracCreateSubscription` (`appSubscriptionCreate`) | `app/lib/billing.server.ts:28` |
| 2 | `mutation SourceTracCancelSubscription` (`appSubscriptionCancel`) | `app/lib/billing.server.ts:51` |
| 3 | `query SourceTracPlans` (`appInstallation.activeSubscriptions`) | `app/lib/shopify-graphql.server.ts:173` |
| 4 | `query SourceTracShopStatus` | `app/lib/shopify-graphql.server.ts:201` |
| 5 | `query SourceTracShopTimezone` | `app/lib/shopify-graphql.server.ts:211` |
| 6 | `query SourceTracShopDisplay` | `app/lib/shopify-graphql.server.ts:222` |
| 7 | `query SourceTracProductTitles` (`nodes`) | `app/lib/shopify-graphql.server.ts:306` |
| 8 | `query SourceTracShopTimezoneOnly` | `app/lib/shopify-graphql.server.ts:374` |
| 9 | `query SourceTracPlan` (`shop.plan.publicDisplayName`) | `app/lib/shopify-rest.server.ts:115` |
| 10 | `query SourceTracPlan` (second copy) | `app/lib/shopify-rest.server.ts:148` |
| 11 | `mutation SourceTracTagsAdd` | `app/lib/sync.server.ts:168` |
| 12 | `mutation SourceTracMetafieldsSet` | `app/lib/sync.server.ts:177` |
| 13 | `mutation SourceTracFlowReceive` (`flowTriggerReceive`) | `app/lib/sync.server.ts:186` |
| 14 | `query SourceTracOrderCustomer` | `app/lib/sync.server.ts:194` |
| 15 | `query SourceTracCustomerOrders` (`orders(query:)`) | `app/lib/admin-survey-context.server.ts:92` |
| 16 | `query SourceTracOrder` | `app/lib/order-backfill.server.ts:25` |

The input types used in variables (`AppSubscriptionLineItemInput`,
`AppPlanInput`, `AppRecurringPricingInput`, `MetafieldsSetInput`) have no
deprecated fields in any of the three versions.

**Webhook topics** in `shopify.app.toml` (`ORDERS_CREATE`, `ORDERS_UPDATED`,
`ORDERS_CANCELLED`, `APP_UNINSTALLED`, `APP_SCOPES_UPDATE`,
`APP_SUBSCRIPTIONS_UPDATE`) all exist in `WebhookSubscriptionTopic` on 2026-07
and 2026-10, and none is deprecated.

**Extension components** were also validated with the toolkit:
`polaris-checkout-extensions` for `purchase.thank-you.block.render`,
`polaris-customer-account-extensions` for `customer-account.order-status.block.render`,
and `polaris-admin-extensions` for the order and customer details blocks. All
`s-*` components and props used are valid for 2026-07.

Scope notes from the validator (informational):

- Operation 14 reads `order.customer`, which needs `read_customers`. That is
  covered by the requested `write_customers`.
- Operation 15 is limited to roughly the last 60 days of orders without
  `read_all_orders`. See L40.

`userErrors` handling is covered by the flow traces below. The raw client
(`shopify-graphql.server.ts:128-147`) throws on HTTP 4xx/5xx and on top-level
`errors`. All three mutations that return `userErrors` check them.

---

## Critical

### C1. No buyer answer ever queues Shopify sync work: tags, metafields and Flow never run [SYNC] — CONFIRMED, re-verified
- **Where:** `app/lib/answers.server.ts:368`, `app/lib/sync.server.ts:80-81`, `app/routes/api.survey-responses.tsx:186`; `prisma/schema.prisma:320`.
- **What is wrong:**
  - `Survey.syncOptions` is a `String` column holding JSON. The route passes `row.syncOptions` (the raw string) to `submitAnswers`.
  - `afterAnswerStored` calls `parseSyncOptions(input.syncOptions)` without `JSON.parse`. `parseSyncOptions` casts its input to an object and reads `.orderTags`, `.metafields`, `.flowTrigger` and `.presets`, which are all `undefined` on a string.
  - So `hasSyncWork` is false and `enqueueSync` is never called.
  - `loadSyncContext` parses correctly (`safeJson`, `sync.server.ts:267`), which is why the sweep looks fine in isolation.
- **Scenario:**
  1. A Scale shop configures order tags `source:{channel}` and the Flow trigger.
  2. A buyer answers.
  3. No `PendingSync` row is created, so no tag, metafield or Flow run happens, and nothing is logged.
- **Why the tests pass:** they call `enqueueSync` / `parseSyncOptions` with objects.
- **Note:** fixing this makes H2, H3, M6 and M7 live.

### C2. A failed offline-token refresh makes `/webhooks` answer 500 before any handler runs, so uninstall, GDPR redaction and order webhooks can fail on every retry [GDPR, AUTH, ORD] — library path CONFIRMED and re-verified; Shopify's refusal is PLAUSIBLE
- **Where:**
  - `app/routes/webhooks.tsx:39`: `await authenticate.webhook(request)` is outside every try.
  - `app/shopify.server.ts:36`: `future.expiringOfflineAccessTokens: true`.
  - Library: `node_modules/@shopify/shopify-app-react-router/dist/esm/server/authenticate/webhooks/authenticate.mjs` → `helpers/ensure-valid-offline-session.mjs` → `helpers/ensure-offline-token-is-not-expired.mjs` → `helpers/refresh-token.mjs`.
- **What is wrong:**
  - With the expiring-token flag on, `authenticate.webhook` loads the offline session on every delivery.
  - If the access token is expired or within 5 minutes of expiry and a refresh token exists, it calls Shopify's refresh endpoint before returning.
  - Any failure throws: `InvalidJwtError`, `HttpResponseError` for `invalid_subject_token`, or `new Response(500)`.
  - Expiring tokens last about an hour, so any shop with no admin visit or webhook in the last hour is in this state.
- **Scenario A (uninstall):**
  1. A merchant uninstalls about 1 hour after the last refresh.
  2. Shopify has revoked the credentials, so the refresh is refused and `app/uninstalled` gets 500 on every retry.
  3. Sessions (which hold the refresh token) are never deleted, `installState` stays `installed` and the plan is never reset.
  4. The retention backstop (`app/lib/retention.server.ts:172-182`) only targets `installState: "uninstalled"`, so it never fires either.
  5. 48 hours later `shop/redact` loads the same session, fails the same way, and the shop's data is never deleted. That is a GDPR compliance failure.
  6. `customers/redact` and `customers/data_request` for that shop also fail.
- **Scenario B (orders):** the refresh token is revoked or expired and a transient error hits Shopify's token endpoint. `orders/create` returns 500 on every retry, the order is never cached, and the answer stays Pending. It becomes "order not received" after 24 hours unless the admin backfill rescues it.
- **Aggravating factor:** order webhooks do not need a token at all (see L22).

---

## High

### H1. A quick reinstall keeps the old `installedAt`, so a late `app/uninstalled` or `shop/redact` treats the live install as uninstalled [AUTH, GDPR] — CONFIRMED in code; the timing is PLAUSIBLE
- **Where:**
  - `app/lib/shop.server.ts:74-77`: `startsInstallation` comes from a separate read before the upsert, and is only true when the stored state is not `installed`.
  - `app/lib/webhooks.server.ts:341-345`: the stale-uninstall guard (`triggeredAt < installedAt`).
  - `app/lib/compliance.server.ts:490`, `:513-518`: `isLaterInstallation`.
- **What is wrong:** if `app/uninstalled` is delayed, failing (see C2) or still retrying when the merchant reinstalls, `upsertShop` keeps the original `installedAt`. Both reinstall guards then compare against that stale timestamp.
- **Scenario A:**
  1. The merchant uninstalls at T0, and the first delivery fails (Neon waking, or C2).
  2. They reinstall at T0+2min.
  3. Shopify retries `app/uninstalled` with triggeredAt=T0, which is later than the old `installedAt`.
  4. The retry deletes the new sessions, sets `uninstalled`, resets the plan to free/cancelled and nulls `subscriptionGid`.
  5. Until the merchant reopens the admin:
     - `orders/*` are acknowledged and ignored (`resolveInstalledShop`, `webhooks.server.ts:51`), so revenue is lost unless the backfill finds it;
     - the new subscription's `app_subscriptions/update` is ignored (`webhooks.server.ts:386`).
- **Scenario B:**
  1. The merchant uninstalls, `app/uninstalled` is never applied, and they reinstall within 48 hours.
  2. `shop/redact` finds the shop `installed` with the old `installedAt`, so `isLaterInstallation` is false.
  3. The handler deletes the live shop: surveys, answers and sessions.
- **Also:**
  - With no `X-Shopify-Triggered-At` header, or a null `installedAt` on pre-migration rows, both guards are skipped entirely (`compliance.server.ts:515-517`, `webhooks.server.ts:343`).
  - A concurrent uninstall landing between the read and the upsert also corrupts `installedAt`.

### H2. A retried or repeated submission re-queues all sync work, so Flow fires again and tags are re-added [SYNC, SUBMIT] — CONFIRMED (live once C1 is fixed)
- **Where:**
  - `app/lib/answers.server.ts:313-315`: a duplicate still calls `afterAnswerStored` (`:375-377`).
  - `app/lib/sync.server.ts:141-162`: `enqueueSync` only skips kinds that are still pending.
  - `app/lib/sync.server.ts:678`: completed rows are deleted.
  - `app/routes/api.survey-responses.tsx:224`: the per-token slot is released for duplicates.
- **What is wrong:** nothing records completed sync work, so a duplicate re-inserts every kind and drains it at once.
- **Scenario:**
  1. The first POST commits and its Flow row runs and is deleted.
  2. The HTTP response is lost (30s timeout or dropped connection).
  3. The extension retries, the result is `duplicate`, and `flowTriggerReceive` fires again.
- **Other triggers:** the same answer from the Thank-you and Order status tabs, or a buyer replaying their own POST. Replays are limited only by the per-order bucket (10 burst, one every 6s).
- **Impact:** the merchant's workflow (discount email, Slack alert) runs once per resubmit.

### H3. `startSyncForOrder` breaks a live lease, so two drainers run the same sync row [SYNC] — CONFIRMED in code; the timing is PLAUSIBLE but likely
- **Where:** `app/lib/sync.server.ts:765-770`, with the lease at `:654-660`.
- **What is wrong:**
  - The reset sets `nextAttemptAt = now` for every row with `nextAttemptAt > now`.
  - A leased row is exactly such a row, because the lease is `nextAttemptAt = now + 2min`.
  - The compare-and-set in `processPendingSync` then lets a second drainer claim it.
- **Scenario:**
  1. The inline drain processes `tags`, then `customer`, then `flow`.
  2. The app's own `tagsAdd` makes Shopify send `orders/updated` about a second later.
  3. That webhook calls `startSyncForOrder`, which resets the leased `flow` row and runs it.
  4. Flow fires twice.
- **Other trigger:** `orders/create` and `orders/updated` arriving together.

### H4. Forged requests can drain the shop-wide rate-limit backstops, so buyers whose order has not been cached yet lose their answer and the survey hides [SUBMIT] — CONFIRMED and re-verified; the webhook lag is PLAUSIBLE
- **Where:**
  - `app/routes/api.survey-responses.tsx:126-134`: the shop backstop is consumed before `getSurveyRow` (`:143-146`).
  - `app/routes/api.survey-responses.tsx:224`: the token slot is released when nothing is stored.
  - `app/routes/api.survey.tsx:97-102`.
  - `app/lib/rate-limit.server.ts:151-152`, `:230-241`.
- **What is wrong:**
  - A request with a valid checkout token, a made-up `orderId` and a non-existent `surveyId` costs one `answer-shop:<shop>` token (100 burst, refill one every 20s), then fails with 400.
  - The failure releases the per-token submission slot, so the 2-per-token cap never stops the attacker.
  - Only orders already in `OrderCache` are exempt. Thank-you answers usually arrive before `orders/create`.
  - `/api/survey` has the same weakness (`survey-shop`, refill 2/s).
- **Scenario:**
  1. One lifted token sends a request roughly every 20s, each with a fresh order id.
  2. Real buyers whose order is not cached yet get 429 for the whole 60s retry budget.
  3. The block hides and the answer is lost (`survey_submit_lost`).
- **Without an attacker:** any burst above about 180 answers per hour on not-yet-cached orders hits the same wall.

---

## Medium

### M1. Open redirect in `/auth/*` through dot segments [AUTH] — bypass CONFIRMED and reproduced in node; reaching it through App Bridge is PLAUSIBLE
- **Where:** `app/routes/auth.$.tsx:25`, `:30`; `app/lib/http.server.ts:97-101`.
- **What is wrong:**
  - `safeInternalPath` checks the raw string for a leading `//`, then the route does `new URL(value, origin)`, which resolves dot segments.
  - `/..//evil.com`, `/.//evil.com` and `/%2e%2e//evil.com` all become pathname `//evil.com` (reproduced).
  - `redirect("//evil.com…")` emits a protocol-relative `Location`.
- **Scenario:** a merchant opens `<app>/auth/x?shop=…&host=…&embedded=1&redirect=/..//evil.com`. After authenticating, the admin iframe is redirected to the attacker's page, which is a phishing surface inside the Shopify admin.

### M2. Concurrent token refreshes reuse one refresh token with no coordination [AUTH, ORD] — PLAUSIBLE (depends on Shopify rotating refresh tokens)
- **Where:**
  - `app/lib/shop.server.ts:186-190` (`freshOfflineToken` → `unauthenticated.admin`).
  - `app/routes/webhooks.tsx:39`, through the library's `ensureOfflineTokenIsNotExpired`.
  - Only the legacy migration is de-duplicated (`app/session-storage.server.ts:73`, `:132`).
- **Scenario:**
  1. `orders/create` and `orders/updated`, or a webhook plus a sync drain, arrive just after the token expired.
  2. Both refresh with the same refresh token.
  3. If Shopify rotates refresh tokens, the loser throws: a 500 for a webhook, or a silent `null` token in `getAccessToken` callers.
  4. In the worst case the last `storeSession` persists an invalidated refresh token, and every later refresh fails (see C2) until the merchant reopens the admin.

### M3. The `shop/redact` reinstall check only looks 49 hours back [GDPR] — PLAUSIBLE
- **Where:** `app/lib/compliance.server.ts:490`, `:513-518`.
- **What is wrong:** `isLaterInstallation` treats an install as "later" only if `installedAt > triggeredAt - 49h`. That assumes Shopify always sends `shop/redact` exactly 48 hours after the uninstall.
- **Scenario:**
  1. The merchant uninstalls and reinstalls soon after.
  2. Shopify sends `shop/redact` later than 49 hours after the uninstall.
  3. The reinstall falls outside the window, so `db.shop.delete` wipes the live shop.
- **Fix direction:** compare against the actual uninstall time instead of a fixed window.

### M4. `customers/redact` leaves the buyer's answers in a stored `DataRequest` export [GDPR] — CONFIRMED
- **Where:** `app/lib/compliance.server.ts:111-125` (the export is written) and `:297-347` (`deleteOrdersForShop` never touches `DataRequest`).
- **Scenario:**
  1. `customers/data_request` arrives for orders A and B, then `customers/redact` for the same orders.
  2. The buyer's verbatim `textValue` and `otherText` stay in `DataRequest.payload`, shown on the Settings page, for up to 30 days after the redact.

### M5. Shopify's 5-second webhook budget is at risk on a cold start [ORD] — PLAUSIBLE
- **Where:**
  - `app/routes/webhooks.tsx:39`, `:61`, `:115`, `:117`, `:120`.
  - `app/lib/webhooks.server.ts:294`, `:456`, `:520-537`, `:545-562`.
- **What is wrong:** before answering, one order delivery does:
  - the session load, plus possibly a token refresh (network);
  - the claim insert;
  - a token lookup it does not need (L22);
  - shop and redacted-order lookups;
  - two to three cache writes;
  - two reconcile passes;
  - the processed mark.

  That is about 10 sequential round-trips, each wrapped in `retryDb` (3 tries).
- **Scenario:** Neon is suspended and the token has expired. The delivery takes more than 5s, so Shopify records a failure and retries. The retry gets 503 while the first is still in flight, so nothing is lost, but the subscription accrues failures.

### M6. A transient token-refresh failure deletes queued sync work for good [SYNC] — CONFIRMED
- **Where:** `app/lib/sync.server.ts:307-308` with `:671-675`; `app/lib/shop.server.ts:186-202`.
- **What is wrong:** `getAccessToken` swallows every error (network fault, Shopify 5xx, refresh race) and returns `null`. `loadSyncContext` returns `null` for that. The sweep reads `null` as "the response is gone" and runs `deleteMany`.
- **Scenario:** one refresh fails while a row is being processed. The row is deleted without counting as a failed attempt, and it never appears in the Settings "failed sync" count.
- **Related:** a short plan blip (`planStatus` frozen or stale, `:320`) also deletes rows instead of deferring them.

### M7. Flow is marked "not idempotent", but the sweep re-sends it after a timeout or 5xx [SYNC] — PLAUSIBLE
- **Where:** `app/lib/sync.server.ts:598-600`, `:680-704`.
- **What is wrong:**
  - `{ idempotent: false }` only stops retries inside `shopifyGraphql`.
  - A 5xx after Shopify accepted the trigger, or the 20s `AbortSignal.timeout` (which `isRejectedBeforeRunning` does not treat as "rejected"), throws into `processPendingSync`.
  - The sweep then retries the trigger up to `MAX_SYNC_ATTEMPTS` (5) times.
- **Impact:** Flow is delivered at least once, possibly up to 5 times. There is no idempotency key and no ledger of completed sends.

### M8. Unanswered optional questions are stored as empty Answer rows, which skews results and fires Learn & stop early [SUBMIT] — CONFIRMED
- **Where:**
  - `extensions/shared/src/use-multi-survey.ts:345-349`: sends `{questionId}` for every visible question, answered or not.
  - `shared/survey-rules.ts:906-913`: `normalize` keeps every entry.
  - `app/lib/answers.server.ts:266-274`: stores them.
- **Effects:**
  - `buildBreakdowns` uses `total: relevant.length` (`app/lib/survey-analytics.server.ts:389`), so option shares on optional questions are understated.
  - `maybeLearnAndStop` counts `answers.length` (`answers.server.ts:430-437`), so a numeric main question reaches `LEARN_STOP_MIN_NUMERIC` early.
- **Scenario:** a 3-question survey with an optional NPS question first. Buyers who skip it still add rows, and the survey auto-pauses before enough real scores exist.

### M9. The 30s attempt timeout does not cover `getSessionToken()`, so a hung token request leaves the block stuck on "Loading…" [SUBMIT] — code CONFIRMED; that the host hangs is PLAUSIBLE
- **Where:** `extensions/shared/src/survey-logic.ts:320-339`.
- **What is wrong:** the timer only calls `controller.abort()`. `await binding.getSessionToken()` is not raced against it.
- **Scenario:** if `shopify.sessionToken.get()` never settles, `withRetries` never returns. The block shows "Loading…" or a disabled "sending" button indefinitely. It never hides and never logs, which breaks the "never block the page" rule.

### M10. Anyone with a checkout token can claim future order ids and block real buyers' answers [SUBMIT] — code CONFIRMED; how predictable order ids are is PLAUSIBLE
- **Where:** `app/routes/api.survey-responses.tsx:113-134`; `app/lib/answers.server.ts:229-245`; `app/routes/api.survey.tsx:130-134` with `app/lib/order-facts.server.ts:227-233`.
- **What is wrong:** `orderId` is chosen by the client and never tied to the token, and only one answer per order is allowed across all surveys.
- **Scenario:**
  1. A forged answer is stored on an order id that does not exist yet.
  2. The real buyer later gets `alreadyAnswered` and is never asked.
  3. When `orders/create` lands, the forged answer is reconciled with the real revenue.
  4. The forged `OrderFact` (first write wins) also poisons first-time-buyer targeting.
- **Limit:** 2 stored answers per token, plus the backstop.

### M11. Removing a question or option from a live survey with 0 answers hard-deletes it [EDIT, SUBMIT] — CONFIRMED
- **Where:** `app/lib/surveys.server.ts:1146` (`hasResponses` from `existing.responseCount`, read outside the transaction), `:604-615`; `shared/survey-rules.ts:760-764`; `Answer.question onDelete: Cascade`.
- **Scenario 1:**
  1. The merchant removes option X from a live survey with no answers yet.
  2. A buyer who loaded the earlier version picks X and submits.
  3. The server answers `unknown_option` (a 400 the extension treats as permanent), the block hides and the answer is lost.
  4. Archived options would have been accepted.
- **Scenario 2:** if the first answer commits at the same moment as the publish, `question.deleteMany` cascade-deletes that buyer's Answer rows.

### M12. A save conflict silently throws away the merchant's unsaved edits [EDIT] — CONFIRMED
- **Where:** `app/routes/app.surveys.$id.tsx:113-119`, `:250-257`; `app/lib/surveys.server.ts:441-444`, `:819-830`.
- **What is wrong:** a conflict returns 200 data, so React Router re-runs the loader. The new `revision` changes `dataKey`, the effect calls `setDraft(survey)`, `dirty` turns false, and the unsaved-changes guard switches off.
- **Scenario:**
  1. Tab A has unsaved edits.
  2. The merchant pauses or activates the survey from the list in tab B, which bumps `revision`.
  3. Tab A presses Save.
  4. Tab A shows "Reload to see the latest version", but its edits are already gone.

### M13. A config read already in progress can put a stale survey back in the cache after a save [EDIT] — CONFIRMED (small window)
- **Where:** `app/lib/surveys.server.ts:1358-1386`.
- **What is wrong:** `invalidateConfig` only deletes the cache entry. A `getCompiledConfig` that started before the merchant's write finishes afterwards and stores the old rows with a fresh timestamp.
- **Scenario:** the merchant pauses a survey, or removes an option, while a buyer's `/api/survey` request is reading. The paused survey, or the removed option, is served for up to 60s.
- **Related:** the downgrade paths in L35 never invalidate at all.

### M14. Downgrades and yearly-to-monthly switches are probably deferred by Shopify, and repeat clicks create more charges [BILL] — PLAUSIBLE (depends on Shopify's default `replacementBehavior`)
- **Where:** `app/lib/billing.server.ts:28-49` (no `replacementBehavior`); `app/routes/app.plans.tsx:249-255` (the "already on this plan" check); `app/lib/i18n/locales/en.json:235` (`yearly_note`).
- **What is wrong:** by default Shopify defers a downgrade, or an annual-to-30-day switch, to the end of the cycle. The new charge sits ACCEPTED while the old one stays ACTIVE.
- **Scenario:**
  1. A merchant on Scale monthly approves Growth monthly.
  2. Plans still shows "Scale, Current".
  3. Clicking Growth again passes the check and creates yet another charge to approve.
  4. The copy "replaces your current charge once you approve it" is wrong in this case.

### M15. Cancelling a yearly subscription forfeits the rest of the year with no warning [BILL] — CONFIRMED (no `prorate`; the refund outcome is Shopify's documented default)
- **Where:** `app/lib/billing.server.ts:51-64`, `:183`; `app/routes/app.plans.tsx:194-216`, `:114-118`; `en.json:191` (`cancel_body`).
- **Scenario:**
  1. A yearly Growth subscriber taps Cancel in month 1.
  2. No prorated credit is issued, and they drop to Free on the next page load.
  3. The confirm dialog only says "You lose unlimited responses".

### M16. Results drops every answer to the built-in "Other" option [REP] — CONFIRMED
- **Where:** `app/lib/survey-analytics.server.ts:352-357`, `:380-384`; `shared/survey-rules.ts:294-295`; `app/routes/app.results.tsx:195`.
- **What is wrong:**
  - With "Allow a free-text answer" on, the rules add an option with id `other` that has no Option row.
  - `buildBreakdowns` builds bars from DB options only, so Other answers count in `total` but get no bar and no revenue.
  - `otherCount` is returned to the page but never rendered.
  - `buildQuestionStats` also walks only `question.options`, so Other can never be the dashboard's top answer.
- **Scenario:** 40% of buyers pick Other. The Results bars add up to 60%, Other's revenue is missing, and the dashboard names the wrong top answer.

### M17. The channel report splits one real channel into several rows [REP] — CONFIRMED
- **Where:** `app/lib/analytics-queries.server.ts:131-137`; `fetchChannelLabels` `:203-207`.
- **What is wrong:** a v2 channel key is the option id, which is unique to each survey. Only `bf-option-` ids are mapped back to legacy slugs.
- **Scenario:**
  1. The shop has two surveys feeding the channel report, for example the migrated backfill survey and a new Channel Compass.
  2. Each produces its own "Instagram" row.
  3. Answers and revenue are split across the two rows.
  4. `pickTopChannel` and the dashboard's top 5 can name the wrong top channel.

---

## Low

### L1. The free-cap month boundary can flag one answer wrongly [BILL, SUBMIT] — CONFIRMED
- **Where:** `app/lib/answers.server.ts:212-214`, `:264`.
- **What is wrong:** `shouldLock` comes from a usage read taken before the transaction.
- **Scenario:** the UTC month rolls over between that read and the claim, so the first answer of the new month is flagged `isLocked`.

### L2. The checkout retry loop does not match the 8-attempt / ~60s spec [SUBMIT] — CONFIRMED
- **Where:** `extensions/shared/src/survey-logic.ts:389-438`, `:200`, `:206`.
- **What is wrong:** there is no attempt cap; the only limit is the 60s budget.
  - Fast failures run about 12-15 attempts.
  - A slow attempt can start at the deadline and run its full 30s, so the worst case is about 90s.

### L3. Options are shuffled with different seeds on the two pages [SUBMIT] — CONFIRMED
- **Where:** `extensions/shared/src/use-multi-survey.ts:292`.
- **What is wrong:** the shuffle is seeded with the raw GID: `gid://shopify/OrderIdentity/N` on Thank-you and `gid://shopify/Order/N` on Order status.
- **Scenario:** the same order sees a different option order on each page, although the comment says the order is identical on both.

### L4. The server accepts a submission where no question has any content [SUBMIT] — CONFIRMED
- **Where:** `app/routes/api.survey-responses.tsx:73` (`min(1)` counts entries, not content); `shared/survey-rules.ts:707-880`.
- **Scenario:** `[{questionId:"q1"}]` on an all-optional survey stores an empty Response. It uses a cap slot, bumps `responseCount` and locks the order out of answering again. The client normally prevents this.

### L5. A stale `surveyVersion` waives every "required" rule [SUBMIT] — CONFIRMED
- **Where:** `app/lib/answers.server.ts:194-199`.
- **What is wrong:** when `surveyVersion < currentVersion`, all required issues are dropped, not just those for questions added after the buyer loaded the survey.
- **Scenario:** a client that sends `surveyVersion: 0` can skip any required question.

### L6. The legacy single-question path has several gaps [SUBMIT, BILL, SYNC] — CONFIRMED; reachable only by stale clients or crafted requests
- **Where:** `app/routes/api.responses.tsx:93-96`; `app/lib/responses.server.ts:85-92`, `:104`, `:117-138`.
- **What is wrong:**
  - The per-token cap is never released, so two 5xx or duplicate attempts burn it and later retries get 429 until the token expires.
  - The "a v2 answer already exists" check runs without the `answer:<shop>:<order>` advisory lock, so a concurrent v2 and legacy submission can write two answers for one order.
  - The answer is inserted before the usage increment. If the increment fails it is only logged, so on Free that answer is stored unflagged and never counted toward the cap.
  - Answers stored here (in `SurveyResponse`) are never synced and never shown in the admin blocks.

### L7. Product and collection targeting is saved and plan-gated but never applied [EDIT, SUBMIT] — CONFIRMED
- **Where:** `app/lib/surveys.server.ts:668-677`; `shared/plan-features.ts:103-104`; `shared/survey-config.ts:223-272`, `:281-295`.
- **What is wrong:** `productIds`, `collectionIds` and `resolvedProductIds` are accepted, but `explainTargeting` never reads them.
- **Effects:**
  - A product-targeted survey shows on every order.
  - The rule still counts as "advanced targeting" for the plan gate.
  - `hasAudienceRules` does not count it.
- **Reachability:** no editor UI sets these today, so only a crafted save or older data carries them.

### L8. Start and end dates on a day whose midnight is skipped by daylight saving land 1 hour early [EDIT, SUBMIT] — CONFIRMED (reproduced by the EDIT trace)
- **Where:** `shared/zoned-date.ts:62-75`.
- **What is wrong:** `startOfDayIso("2026-09-06","America/Santiago")` returns `2026-09-06T03:00Z`, which is 23:00 the previous day. `storedToDateField` then shows Sept 5.
- **Scenario:** a Chilean merchant picks a start of Sept 6. The survey starts an hour early, and the date field displays Sept 5.

### L9. In the one-question-at-a-time layout, "Next" skips required questions without feedback [SUBMIT] — CONFIRMED
- **Where:** `extensions/shared/src/MultiSurveyView.tsx:110-118`; `use-multi-survey.ts:434-436`.
- **What is wrong:** on the last step Submit is simply disabled, with nothing showing which earlier question is missing.
- **Effect:** buyers may give up. Nothing is lost on the server.

### L10. Redacted orders get new `CheckoutLoad` and `OrderFact` rows [GDPR] — CONFIRMED
- **Where:** `app/lib/order-facts.server.ts:12-18`; `app/lib/serve-log.server.ts:59-72`; called from `app/routes/api.survey.tsx:133`, `:230`.
- **What is wrong:** neither write checks `isRedactedOrder`.
- **Scenario:** after `customers/redact`, the buyer reopens the Thank-you page. A new `OrderFact` (kept 90 days) and a `CheckoutLoad` with order id and country (kept 30 days) are written.

### L11. A redacted order can be re-cached by a concurrent order webhook [ORD] — CONFIRMED (needs concurrency)
- **Where:** `app/lib/webhooks.server.ts:456` (the redacted check), then `:520-537` (the write). Not atomic with the redact.
- **Scenario:**
  1. `orders/updated` passes the redacted check.
  2. `customers/redact` deletes the `OrderCache` row and inserts `RedactedOrder`.
  3. The webhook's update matches 0 rows, falls back to `create`, and recreates the redacted order's row.

### L12. The deferred-redact drain does not save its progress [GDPR] — CONFIRMED
- **Where:** `app/lib/compliance.server.ts:376-392`, `:405-421`.
- **What is wrong:**
  - `startPendingDeletions` runs with `maxBatches = Infinity`, so the payload is only rewritten once the whole row is drained. A restart mid-drain starts over.
  - The dashboard and webhook drainers are not mutually excluded.
- **Impact:** repeated work only; the deletes are idempotent.

### L13. An unparseable `PendingDeletion` payload silently drops the deletion obligation [GDPR] — CONFIRMED (unlikely, since the payload is self-written)
- **Where:** `app/lib/compliance.server.ts:365-373`, `:384-385`.
- **What is wrong:** a parse failure, or a non-array `orderIds`, sets `orderIds = []`. The row is then deleted with no log line.

### L14. The deferred-redact sweep depends on traffic [GDPR] — PLAUSIBLE (deployment-dependent)
- **Where:** `app/routes/webhooks.tsx:125-126`; `app/lib/compliance.server.ts:430-445`.
- **What is wrong:** the remainder is drained only by other webhooks, dashboard visits or the external retention job. The in-process drain started by the redact is lost on a restart.
- **Scenario:** a quiet, uninstalled shop with no cron configured can miss Shopify's 30-day deadline.

### L15. Large `customers/redact` requests do work proportional to their size inline [GDPR] — PLAUSIBLE
- **Where:** `app/lib/compliance.server.ts:239-246`, `:252`.
- **What is wrong:** `RedactedOrder.createMany` and `orderFact.deleteMany` run for every 1,000-order chunk, plus a `LIKE` scan of `PendingDeletion.payload`, all before the 200-order inline batch.
- **Scenario:** a large redact on a cold Neon can exceed 5s. The retry gets 503, so nothing is lost.

### L16. The retention backstop can delete a just-reinstalled shop's sessions [GDPR] — CONFIRMED (narrow race)
- **Where:** `app/lib/retention.server.ts:173-182`.
- **What is wrong:** sessions are deleted by domain unconditionally, before the conditional `shop.deleteMany({ installState: "uninstalled" })`.
- **Scenario:** a reinstall that lands in between loses its new session and has to re-authenticate.
- **Also:** `uninstalledShopsDeleted` counts candidates, not actual deletions.

### L17. `app/scopes_update` overwrites the stored scope with no ordering guard [GDPR, AUTH] — PLAUSIBLE
- **Where:** `app/lib/webhooks.server.ts:361-373`.
- **What is wrong:** there is no `triggeredAt` / `installedAt` comparison.
- **Scenario:** an out-of-order or pre-reinstall delivery writes an older scope set onto the new session. `canSync` then skips writes the merchant granted, and Settings shows the wrong grant state. It also writes for uninstalled shops.

### L18. The `customers/data_request` export omits data held for the named orders [GDPR] — CONFIRMED
- **Where:** `app/lib/compliance.server.ts:131-188`.
- **What is wrong:** only answers are exported. `Response.country`, `locale`, `productIds` and `isFirstOrder`, the `OrderCache` totals, `OrderFact` and `CheckoutLoad.country` are all left out.

### L19. Legacy-session migration races can leave a revoked token stored [AUTH] — CONFIRMED in code; the timing is unlikely
- **Where:** `app/session-storage.server.ts:104-115`, `:129-152`.
- **What is wrong:**
  - A load whose DB read finishes after the migration's `finally` re-migrates with the already-revoked legacy token.
  - A plain-text re-seal `storeSession` that lands after the migrated session overwrites it with the revoked legacy token.
  - After that, every later load reports no session, and webhooks and background work get no token until the merchant opens the admin.
  - The de-duplication only works within one process.

### L20. Legacy migration runs a network call of up to 20s inside webhook authentication [AUTH] — CONFIRMED
- **Where:** `app/lib/token-migration.server.ts:218`, reached through `loadSession` from `authenticate.webhook`.
- **What is wrong:** the first webhook for a legacy session waits on a token exchange of up to 20s, while Shopify's timeout is 5s. A failed migration is retried on every load, because nothing records the failure.

### L21. Key rotation never re-seals tokens proactively [AUTH] — CONFIRMED
- **Where:** `app/lib/env.ts:42-46` (the comment promises re-sealing); `app/session-storage.server.ts:26`, `:104`.
- **What is wrong:** `sealToken` skips values that already carry the `enc:v1:` prefix, and `loadSession` only re-seals plain-text rows.
- **Scenario:**
  1. A shop has no refresh or token exchange during the rotation window.
  2. `TOKEN_ENCRYPTION_KEY_PREVIOUS` is removed.
  3. The shop's tokens can no longer be decrypted (logged at warn only), and background Admin calls stop until the merchant reopens the app.

### L22. Every order webhook resolves an access token it never uses [ORD] — CONFIRMED
- **Where:** `app/routes/webhooks.tsx:115`, `:166-170`.
- **What is wrong:** only `app_subscriptions/update` uses the token. When there is no session, `orders/*` still pays for a DB lookup plus `unauthenticated.admin`, and possibly a legacy exchange (network). That adds latency and failure points to M5 and C2.

### L23. `/auth/*` calls `provisionShop` with no error handling [AUTH] — CONFIRMED
- **Where:** `app/routes/auth.$.tsx:21`.
- **What is wrong:** `afterAuth` swallows provisioning errors, but this second, redundant call does not.
- **Scenario:** a DB blip or Neon wake turns a successful login into a 500 inside the iframe. It also makes a duplicate `fetchShopIdentity` Admin call.

### L24. A changed myshopify domain makes provisioning fail permanently [AUTH] — PLAUSIBLE (depends on whether Shopify allows domain changes)
- **Where:** `app/lib/shop.server.ts:54-61`, `:79-100`.
- **What is wrong:** `Shop.shopId` (the GID) is `@unique`, but the upsert is keyed on `shopDomain`.
- **Scenario:** after a domain change, the create branch hits P2002 and `retryUniqueRace` gives up. `ensureShop` then throws on every admin load, so the merchant is locked out.

### L25. Backfill writes erase the same-second tie-break [ORD] — CONFIRMED; the window is narrow
- **Where:** `app/lib/webhooks.server.ts:482`, `:500-511`; `app/lib/order-backfill.server.ts:193` (passes no `triggeredAt`).
- **Scenario:**
  1. The backfill reads an order.
  2. Webhook A (`updated_at` U, triggered T2) writes the row.
  3. The backfill writes the same U with `triggeredAt = NULL`.
  4. A delayed webhook B (same U, older T1) passes the guard and overwrites A's newer same-second state, for example `financial_status` going from paid back to pending.

### L26. An order with an unreadable total is reported as "order not received", and is never re-fetched [ORD, REP] — CONFIRMED
- **Where:**
  - `app/lib/webhooks.server.ts:543` (no reconcile when the total is null).
  - `app/lib/answers.server.ts:579-590` (the 24h sweep sets `unverifiedFailed`).
  - `app/lib/survey-analytics.server.ts:233-235` (checks `unverifiedFailed` before "total unreadable").
  - `app/lib/order-backfill.server.ts:162-164` (`WHERE o.id IS NULL` never re-fetches a row with a null total).
- **Effect:** the Responses page and the survey CSVs say "order not received" for an order that did arrive. The legacy channel CSV (`analytics-queries.server.ts:391-392`) checks in the opposite order, so the two exports disagree.

### L27. Migrated rows with `verified = NULL` are never written off [ORD] — PLAUSIBLE (Prisma's NULL semantics for `not`)
- **Where:** `app/lib/answers.server.ts:584` (`verified: { not: true }`).
- **What is wrong:** if Prisma compiles this to `<> true`, NULL rows are excluded. Backfilled history with `verified = NULL` and no total would then stay "awaiting order" forever, instead of ageing out like every other answer.

### L28. Every order update bypasses the sync retry backoff [ORD] — CONFIRMED
- **Where:** `app/lib/webhooks.server.ts:324` → `app/lib/sync.server.ts:759-772`.
- **What is wrong:** each applied `orders/updated` or `orders/cancelled` resets `nextAttemptAt` and drains immediately.
- **Scenario:** a sync that fails permanently (missing scope, bad metafield) burns one of its 5 attempts on every fulfillment, tag or payment update. A cancelled order also triggers sync work.

### L29. Backfilled orders never start the sync work waiting for them [ORD, SYNC] — CONFIRMED
- **Where:** `app/lib/order-backfill.server.ts:193`.
- **What is wrong:** the backfill writes through `upsertOrderCache` but never calls `startSyncForOrder`, unlike `webhooks.server.ts:324`. Those rows wait for the 5-minute admin sweep or the backoff, and may give up.

### L30. One permanent error parks a whole backfill batch for a week [ORD] — CONFIRMED in code; the 401 needs a stale token
- **Where:** `app/lib/order-backfill.server.ts:167`, `:177`, `:199-201`.
- **What is wrong:**
  - Any non-throttle `ShopifyGraphQLError`, including a 401 or 403 from a stale token, sets a 7-day backoff for that order.
  - One bad-token run therefore parks all 10 due orders, and meanwhile their answers become "order not received".
  - The candidate query is capped at `LIMIT 100` before the backoff filter, so older eligible orders can starve.

### L31. A silent hourly backfill retry for orders that can never be stored [ORD] — CONFIRMED
- **Where:** `app/lib/order-backfill.server.ts:188-207`.
- **What is wrong:** when `upsertOrderCache` returns null (for example `currentTotalPriceSet` is null, so the currency is `""`), the result is not counted. The order is retried hourly forever, with no warning log.

### L32. A failed development-store lookup downgrades or ignores a dev store's test plan [BILL] — CONFIRMED
- **Where:** `app/lib/billing.server.ts:296-312` (returns false on any error; failures are not cached); `app/routes/app.plans.tsx:96-118`, `:245`, `:265`; `app/lib/webhooks.server.ts:621-623`.
- **Scenario:** the `partnerDevelopment` query fails once on a dev store that has a Growth test charge.
  - On the Plans page, `setPlan(free, "expired")` is written.
  - The ACTIVE webhook is ignored and acknowledged with 200, so it is never retried.
  - New charges are created as real charges, not test charges.
- **Impact:** this hits App Store review stores.

### L33. The dev-store answer is cached for an hour per process [BILL] — CONFIRMED
- **Where:** `app/lib/billing.server.ts:289-311`.
- **Scenario:** a dev store transferred to a real merchant keeps "test charges count" for up to 1 hour. In that hour its old test charge grants a paid plan, and new charges are created with `test: true`.

### L34. Webhook notices with no access token are applied without checking Shopify [BILL] — path CONFIRMED; whether the payload carries a `test` flag is PLAUSIBLE
- **Where:** `app/lib/webhooks.server.ts:612`, `:629-635`, `:640`.
- **When `accessToken` is null:**
  - A late ACTIVE retry for the old plan after an upgrade overwrites the new plan and its `subscriptionGid`.
  - A late PENDING or ACCEPTED notice is applied as `frozen`, which drops the merchant to the Free cap.
  - The test-charge fallback reads `payload.test`. If the payload has no `test` field, a test charge grants a paid plan in production.

### L35. Webhook downgrades and uninstall never invalidate the compiled checkout config [BILL] — CONFIRMED
- **Where:** `app/lib/webhooks.server.ts:647-655` (`db.shop.updateMany`, not `setPlan`); `app/lib/shop.server.ts:209-230`.
- **Effect:** for up to 60s (`surveys.server.ts:1356`), buyers are served more live surveys than the downgraded plan allows.

### L36. A paid plan is only re-synced from Shopify on the Plans page [BILL] — PLAUSIBLE
- **Where:** `app/lib/webhooks.server.ts:612-620`; `app/routes/app.plans.tsx:90-131`.
- **What is wrong:** an ACTIVE notice that arrives before `activeSubscriptions` lists the charge is logged as "stale active ignored" and acknowledged with 200, so Shopify never retries it.
- **Scenario:** a merchant who closes the tab instead of returning through the approval URL pays for the plan but stays on the Free limits until they open Plans again.

### L37. The Plans loader can overwrite a newer webhook write with an older Shopify read [BILL] — PLAUSIBLE (narrow race)
- **Where:** `app/routes/app.plans.tsx:92-118`.
- **What is wrong:** `setPlan` is an unconditional write based on a Shopify read made earlier in the same request.
- **Scenario:** an ACTIVE webhook for a just-approved charge commits between that read and the write. The loader writes back the old plan and subscription id.

### L38. Plans copy promises more than the code does [BILL] — CONFIRMED
- **Where:** `app/lib/plans.ts:107`, `:121`, `:124`; `en.json:191`, `:213`, `:241`; `shared/survey-rules.ts:42`.
- **What is wrong:**
  - "Unlimited live surveys", but `MAX_SURVEYS_TOTAL` is 50.
  - "Priority email support" has no matching implementation.
  - The cancel copy leaves out that all but one live survey stop being served and that sync stops.
  - After a mid-month downgrade the merchant is often already over 50 answers, because usage is counted per UTC month across plans. Every later answer is flagged, which contradicts "back on the Free plan with 50 responses a month".

### L39. Cancelling can report failure for a charge that was cancelled [BILL] — PLAUSIBLE
- **Where:** `app/lib/billing.server.ts:178-189`.
- **What is wrong:** the cancel mutation is retried on 5xx (default `idempotent: true`). The retry's "already cancelled" userError is then shown as `msg_cancel_failed`. The returned `status` is never checked.

### L40. The customer admin block misses older answers [SYNC] — 60-day limit PLAUSIBLE; 100-order limit CONFIRMED
- **Where:** `app/lib/admin-survey-context.server.ts:92-98`.
- **What is wrong:** `orders(query:"customer_id:…", first: 100)` without `read_all_orders` only sees about the last 60 days, and at most 100 orders.
- **Scenario:** a customer who answered 3 months ago and has not ordered since shows "No survey answer recorded".

### L41. The admin block can show an unrelated answer as "How they heard about us", or "no answer" when one exists [SYNC] — CONFIRMED
- **Where:** `app/lib/admin-survey-context.server.ts:76-77`, `:85`, `:141-142`.
- **What is wrong:**
  - With `channelReportQuestionId` null, it falls back to `response.answers[0]`, loaded with no `orderBy`, so the row is unpredictable.
  - That answer may come from a gift, price or NPS question, or be the buyer's free text.
  - A yes/no answer shows the raw value "yes".
  - Text, NPS and rating answers produce `found:false`.

### L42. Admin block server errors show as "no answer recorded" [SYNC] — CONFIRMED
- **Where:** `app/routes/api.admin-survey-context.tsx:102-110`; `extensions/shared/src/admin-response-block.tsx:70-74`.
- **What is wrong:**
  - A DB or Shopify failure returns 200 `{found:false}`.
  - 401 and 429 responses also end as "No survey answer recorded", which tells the merchant something false.
  - Responses are sent without `Content-Type: application/json`.

### L43. Smart-action tags can carry internal row ids instead of option keys [SYNC] — CONFIRMED
- **Where:** `app/lib/sync.server.ts:338-341`; `shared/templates/smart-actions.ts:306-309`.
- **Scenario:** a merchant adds "TikTok" to a template survey. The new option has `templateKey = null`, so the buyer's order is tagged `found:cm2x9…` (a cuid).

### L44. The inline Thank-you sync always runs before the order exists [SYNC] — PLAUSIBLE
- **Where:** `app/lib/answers.server.ts:377`; `app/lib/sync.server.ts:450-602`.
- **What is wrong:** every kind fails on the first try, because the order is not known yet. This wastes Admin API calls and uses up one of the 5 `MAX_SYNC_ATTEMPTS`.

### L45. Queued sync work only drains while the merchant is in the admin, or when an order webhook arrives [SYNC] — CONFIRMED
- **Where:** `app/lib/sync.server.ts:716-734`, called only from `app._index.tsx:65` and `app.dashboard.tsx:59`.
- **What is wrong:** each sweep drains at most 10 rows, at most once every 5 minutes per process.
- **Scenario:** after a store-wide outage leaves a backlog, rows older than 7 days are dropped silently (`sync_dropped_stale`).

### L46. The 2-minute sync lease can run out during slow, throttled work [SYNC] — PLAUSIBLE
- **Where:** `app/lib/sync.server.ts:73`, `:695-703`.
- **What is wrong:**
  - Up to 4 attempts × 20s, plus sleeps, is about 130s for one call, and the customer and metafield kinds make two calls.
  - Another drainer then reclaims the row.
  - The failure update does not check the lease, so a stale drainer can overwrite the new owner's schedule.

### L47. The Flow "Channel label" can contain line breaks and the buyer's free text [SYNC] — PLAUSIBLE
- **Where:** `app/lib/sync.server.ts:578-581`.
- **What is wrong:** for an "Other" answer, raw buyer text (up to 500 characters, newlines kept) is sent into a `single_line_text_field`. `singleLine()` is not applied, and anything the buyer typed (an email or phone number) flows into the merchant's workflows.

### L48. Metafield writes fail permanently on a type conflict or duplicate key [SYNC] — PLAUSIBLE
- **Where:** `app/lib/sync.server.ts:486-555`; `shared/templates/smart-actions.ts:182-193`.
- **What is wrong:**
  - Every value is written as `single_line_text_field`, including the numeric `reorder_window_days`.
  - A merchant definition with another type on that key, or a merchant metafield that duplicates a preset's namespace and key in the same atomic `metafieldsSet`, fails the whole batch, order metafields included.
  - The batch is retried 5 times and then given up.
  - The namespace `sourcetrac` is merchant-owned, not app-reserved (`$app:`).

### L49. Several editor problems [EDIT] — CONFIRMED unless noted
- **Live-survey limit blocks saving a paused survey.** `app/routes/app.surveys.$id.tsx:95`, `:292-298`, `:602`. At the limit, `fits_plan` disables "Save and publish" even for a paused survey, so a Free shop cannot fix a typo in it. The save bar's Save button ignores the block.
- **Drafts undo an explicit null.** `app/lib/surveys.server.ts:269`, `:272`. `draft.intro ?? published.intro` and the same for `channelReportQuestionId` turn the merchant's "cleared" back into the published value, and the next save re-posts it.
- **Order-value min above max is accepted.** `app/lib/surveys.server.ts:662-667`. The survey then shows to nobody.
- **Order-value currency can be wrong** (PLAUSIBLE). `app/routes/app.surveys.$id.tsx:86`; `app/components/survey-settings-panels.tsx:101-102`. A failed shop-display lookup falls back to "USD", and the backstop at `:183-187` only fills a missing currency. On an EUR store the rule then never matches.
- **After a downgrade, a grandfathered advanced rule can only be kept or removed** (`surveys.server.ts:886-888`). Narrowing it is refused. `shopify_actions` is compared by `JSON.stringify`, so a different key order is refused too (key order is PLAUSIBLE).
- **Expected errors and crafted input reach the generic 500 screen.**
  - An unknown survey id gives `NotFoundError` as a 500 (`app.surveys.$id.tsx:73`).
  - Missing or bad `survey` JSON becomes a 500 (`:171`, `:178`); a body of `"null"` is a TypeError (`:183`).
  - `layout` is never validated (`surveys.server.ts:625-750`, `:979`, `:1074`).
  - A non-string `title` throws in `textTooLong` (`shared/survey-rules.ts:533`).
  - A delete racing a delete is P2025 (`surveys.server.ts:1218`, `:1228`).
- **Duplicate question ids are not rejected** (`shared/survey-rules.ts:578-681`; `surveys.server.ts:543-545`, `:585`). One question is silently lost, and a reused option id can remap a follow-up condition to the wrong option.
- **The compiled-config size limit is enforced only in the browser** (`shared/templates/readiness.ts`; `surveys.server.ts:1380-1383`). The server's check compares the whole multi-survey config against a per-survey limit.

---

## Info

### I1. The 2-per-token submission cap gives no protection against backstop draining [SUBMIT]
Failed submits release the slot. See H4. `app/routes/api.survey-responses.tsx:224`.

### I2. Buyers receive merchant settings [SUBMIT]
`compileSurvey` (`app/lib/surveys.server.ts:1312-1337`) sends buyers the full `targeting` (countries, sample %, `maxResponses`, value bounds), `responseCount`, rotation weights and `channelReportQuestionId`.

### I3. Any buyer token works in the preview route [SUBMIT]
`/api/survey-preview` (`app/routes/api.survey-preview.tsx:57`, `:65`, `:86-99`) accepts buyer tokens, not only editor tokens, and returns draft or paused surveys by id. Its shop-wide key `survey-preview:<shop>` can be drained, which leaves the merchant's checkout-editor preview retrying.

### I4. An empty `placement` passes validation [SUBMIT]
`app/routes/api.survey.tsx:76`: `placement=` passes validation and is treated as "not_on_page" (`??` does not catch an empty string).

### I5. Recent checkouts can be flooded with forged order ids [SUBMIT]
`app/routes/api.survey.tsx:230`; `app/lib/serve-log.server.ts:153`, `:178-184`. Only 20 rows are kept per shop, so forged entries push out the merchant's real diagnostics.

### I6. "None of these" can never be the only answer on some questions [SUBMIT]
On a multi-choice question with `minSelections ≥ 2`, an exclusive "None of these" can never be the only answer. Client and server agree, so nothing is lost, but the buyer is blocked.

### I7. The bot-filter 410 has no CORS header and is retried for 60s [SUBMIT]
`app/lib/checkout-auth.server.ts:297`; `extensions/shared/src/survey-logic.ts:212`.

### I8. Order-id assumption not verified [SUBMIT] (PLAUSIBLE)
`orderIdSchema` (`app/lib/settings.ts:339-367`) assumes the number in `gid://shopify/OrderIdentity/<n>` equals the REST order id stored by `orders/create`. If it does not, Thank-you answers never reconcile.

### I9. Webhook headers are not signed [ORD]
Shopify's HMAC covers only the body. The shop-domain, webhook-id and triggered-at headers are unsigned, so a captured signed `orders/*` body could be replayed against another shop with a fresh webhook id. Bodies are not logged or stored, so the risk is low. `app/routes/webhooks.tsx:40`, `:55`.

### I10. De-duplication keys on webhook id, not event id [ORD]
One event delivered through two subscriptions is processed twice. The handlers are idempotent. `app/lib/webhooks.server.ts:144-213`.

### I11. Zero-decimal currency rounding, and silent overflow in currency sums [ORD]
- A zero-decimal currency with cents (ISK `"1990.50"`) is rounded half-up, so it can differ from Shopify's figure by up to one unit (`app/lib/money.ts:83-91`).
- `rollupByCurrency` silently skips a sum that is not a safe integer, with no log (`app/lib/revenue.ts:104`).

### I12. Comment disagrees with the revenue decision, and a snapshot fallback skips test and cancelled checks [ORD, REP]
- `app/lib/survey-analytics.server.ts:183-188`: the comment says `verified === false` excludes revenue, but the code never reads `verified`.
- The snapshot fallback (`:203-211`) hard-codes `isTest:false`. Its answer reads "counted" but is never summed, because `summariseSurvey` and `buildBreakdowns` (`:367`, `:501`) require `response.order`.

### I13. Pending and authorized orders count as revenue [ORD]
They count until a later update voids them (`app/lib/revenue.ts:49-73`). This is a policy choice, but merchants may read it as captured revenue.

### I14. Ledger rows outlive `shop/redact` [GDPR]
Compliance and shopless ledger rows are stored with `shopId` null, so the shop/redact cascade does not remove them. They hold no payload and age out in 30 days. `app/routes/webhooks.tsx:105`, `:120`.

### I15. `customers/redact` deletes whole days of `SurveyDailyStats` [GDPR]
It removes other buyers' counts too (`app/lib/compliance.server.ts:331-336`). Nothing reads the table today.

### I16. 24-month retention is 730 days [GDPR]
`app/lib/retention.server.ts:27`. `RedactedOrder` tombstones also expire then, after which a late `orders/updated` could re-cache that order.

### I17. Plan status inconsistencies [BILL]
- After a Plans-page reconcile the `plan` column can flip back to `growth`, `cancelled` (`app.plans.tsx:114-118` with `webhooks.server.ts:647-655`).
- A late CANCELLED from a previous install matches `subscriptionGid: null` after a reinstall (`webhooks.server.ts:651`).
- FROZEN is overwritten as `expired` (`app.plans.tsx:116`).
- `planDisplayName` is never updated on a reconcile.

### I18. The confirmation-URL check accepts any `*.myshopify.com` host [BILL]
It does not check that the host is the merchant's own shop. The URL only ever comes from Shopify. `app/lib/billing-redirect.ts:23`.

### I19. The shell plan badge goes stale [BILL]
It does not update after a webhook plan change until a form submit or a full reload (`app/routes/app.tsx:156-161`, `shouldRevalidate`).

### I20. `verifyIdToken` decodes leniently and throws the wrong error type [AUTH]
- The signature is decoded with Node's permissive base64.
- A JSON `null` header or payload throws `TypeError` instead of `IdTokenError`, so the route logs a server error rather than returning 401.

`app/lib/id-token.server.ts:55`, `:91-99`.

### I21. The library logs on every token exchange [AUTH]
See the Step 1 package table (`shopify-app-react-router` 3.0.1).

### I22. `requiresFirstOrder` presets trust the client [SYNC]
They use the `isFirstOrder` value from the request body (`app/routes/api.survey-responses.tsx:70`, `:179`; `shared/templates/smart-actions.ts:378`).

### I23. Editor smaller items [EDIT]
- Pause and activate ignore the posted revision (`app.surveys.$id.tsx:154-160`, `:192`; `surveys.server.ts:1191-1221`).
- The channel-report question's type is not checked on the server (`surveys.server.ts:1008-1018`, `:1107-1118`). On multi_choice only the first pick is counted (`analytics-queries.server.ts:134-149`), and on yes_no "yes" and "no" become channels.
- Relabelling an option moves its whole history to the new label with no warning (`surveys.server.ts:570-572`).
- `validateSurveySettings` and `readIndexedOptions` are dead code (`app/lib/settings.ts:189-275`, `:383-395`).
- Deleting a survey cascades away all its revenue history behind a two-tap confirm (`surveys.server.ts:1223-1231`).
- Rotation and Learn & stop keep running after a downgrade (`surveys.server.ts:1312-1334`; `api.survey.tsx:212-213`; `answers.server.ts:350`).
- The save bar posts even when readiness blocks going live (`unsaved-changes.tsx:95`).

### I24. Reporting precision, ordering and denominator issues [REP]
- The dashboard's "Top channel" badge ranks by answers, while the channel report ranks by revenue (`app/components/dashboard.tsx:220`; `app/lib/analytics.ts:168`, `:279-300`).
- `pickTopChannel` compares raw minor units across currencies (`analytics.ts:285-288`).
- The Results CSV ignores the on-screen date range (`app.results.tsx:240`; `app.results_.csv.tsx:31-38`).
- Responses pagination has no id tiebreaker (`survey-analytics.server.ts:100`).
- The dashboard reads archived questions as live (`dashboard.server.ts:287-299`), and `scores.asks` counts archived questions and paused surveys.
- The channel response rate is inflated for days before install (`analytics-queries.server.ts:265-303` with `order-backfill.server.ts:146-170`).
- Exports print the raw id `other` instead of a label (`answer-text.ts:206`; `survey-export.server.ts:59-62`; `app.responses.tsx:62-67`).

### I25. Export size and performance [REP]
- The all-surveys export caps responses, not rows, at 50,000, so a file can hold about 250,000 rows while `X-SourceTrac-Row-Limit` says 50,000. The whole file is also built in memory (`survey-export.server.ts:66-77`, `:120-146`; `app.export_.csv.tsx:69-75`).
- Survey shapes are loaded one survey at a time (`survey-export.server.ts:123-125`).
- The Results loader runs one correlated-EXISTS count per survey on every load (`app.results.tsx:117`).
- The hourly `maybeMarkUnreconcilable` runs an unbounded UPDATE across every shop (`answers.server.ts:562-574`).

### I26. Smaller reporting inconsistencies [REP]
- `formatDecimalForCurrency` formats through a float (`money.ts:293-305`).
- Results sends minor-unit integers to the browser (`app.results.tsx:177`).
- The Results buyer counts include order-less answers, while the Dashboard's `buyerMix` excludes them.
- Out-of-range numeric answers get bars but are ignored by the scores.

### I27. Queued redactions stay visible in exports for up to a day [REP]
Deferred redactions stay visible in CSV, Results and Responses until a dashboard visit or the daily job drains them. That is within Shopify's 30-day deadline.

---

## Checked and found sound

Reported by the traces as verified, not findings:

- **Auth:**
  - Shop identity always comes from the verified session token `dest`, the ID token or the webhook header, never from a body or query field.
  - Every `app.*` loader and action calls `authenticate.admin`.
  - The checkout auth wrapper adds CORS on every path.
  - The ID token is verified with HS256, a constant-time compare, and checks on `exp`, `nbf`, `aud` and `iss`.
  - AES-GCM uses a 12-byte random IV and checks the tag.
- **Shop scoping:** every Prisma and raw SQL read in reporting and export filters by `shopId`, and survey ids from the URL are resolved against the shop's own surveys.
- **Webhooks:**
  - Insert-first idempotency re-claims only failed or abandoned rows, and an in-flight duplicate gets 503.
  - The `updatedAtShop` ordering guard has a `triggeredAt` tie-break.
  - A cancellation is never cleared.
  - Out-of-order create, update and cancel are handled.
  - An unparseable total never becomes $0.00.
  - Topic names are normalised.
- **Revenue:** never summed across currencies; AOV is per currency; null rates and scores are never shown as 0; periods are UTC and half-open.
- **CSV:** formula injection (including after leading whitespace), RFC 4180 quoting, BOM and CRLF are all handled.
- **Billing:**
  - A paid plan needs an ACTIVE charge read live from Shopify.
  - Test charges do not grant a plan on real stores.
  - A failed read keeps the stored plan.
  - Prices are integer minor units.
  - Usage increments are atomic, and the cap only flags answers, never hides them.
- **GDPR:**
  - Every shop-scoped table cascades on `shop/redact`.
  - Redaction is scoped by the verified shop's internal id.
  - Compliance handler failures return 500.
  - `/healthz` touches no database, and `/readyz` and `/jobs/retention` use `timingSafeEqual`.
- **Sync:**
  - `userErrors` are checked on `tagsAdd`, `metafieldsSet` and `flowTriggerReceive`.
  - `hasScope` uses an exact match.
  - The customer query only interpolates digits.
  - The Flow payload keys match the TOML.
- **Editor:**
  - All survey lookups are scoped by `shopId`.
  - Follow-up conditions can only point at earlier questions.
  - `claimRevision` is atomic.
  - Survey creation and activation limits run under an advisory lock.
