# Logic map — SourceTrac

Developer-facing map of every decision point, with the file and function that
implements it. Built during the logic/security/completeness audit (Phase A) and
kept in step with the code.

Legend for the difference markers that remain:

- **⚠ differs** — the code does something different from the upgrade plan. Every
  marker below is explained inline. (No unmarked divergences are known.)

---

## 1. Show or hide a survey (checkout / order-status)

```mermaid
flowchart TD
  A["Extension render\n(ThankYouBlock / OrderStatusBlock)"] --> B{"shopify.extension.editor?"}
  B -- yes --> PREVIEW["MultiSurveyPreview\n(sample data, nothing submitted)"]
  B -- no --> C{"order id resolved?"}
  C -- no --> NOTHING["render null\n(never block the page)"]
  C -- yes --> D["GET /api/survey?orderId&placement\nBearer session token"]
  D --> E["authenticate.public.checkout()\n401 on bad token; CORS added"]
  E --> F["per-order token bucket\n+ shop-wide backstop"]
  F --> G["findShopByDomain(dest)"]
  G -- unknown/uninstalled --> DISABLED["enabled:false\nreason:not_installed"]
  G -- known --> H["hasAnyAnswerForOrder()\nalreadyAnswered?"]
  H --> I["getCompiledConfig(shopId)\nin-memory cache, 60s TTL"]
  I --> J["priority loop: first active survey\nwhose placements include this one\nand matchesTargeting(targeting, facts)"]
  J -- none match --> DISABLED2["enabled:false\nsurvey:null"]
  J -- match --> K{"alreadyAnswered?"}
  K -- yes --> HIDE["enabled:true, survey set\nblock hides (mutually exclusive pages)"]
  K -- no --> RENDER["render questions\nclient-side show-if decides visibility"]
```

| Decision | File / function |
|---|---|
| Editor preview | `extensions/sourcetrac-*/src/*Block.tsx` (`shopify.extension.editor`) |
| Route + auth + CORS | `app/routes/api.survey.tsx` → `loader` |
| Rate limiting | `app/lib/rate-limit.server.ts` → `consumeToken`, `consumeShopBackstop` |
| Shop lookup | `app/lib/shop.server.ts` → `findShopByDomain` |
| Already answered | `app/lib/answers.server.ts` → `hasAnyAnswerForOrder` |
| Compiled config + cache | `app/lib/surveys.server.ts` → `getCompiledConfig`, `buildConfig` |
| Priority + targeting | `app/routes/api.survey.tsx` (`config.surveys.find`) + `shared/survey-config.ts` → `matchesTargeting` |
| Client-side show-if | `extensions/shared/src/use-multi-survey.ts` → `questionVisible` (mirrors `isQuestionVisible`) |

Status, placement, dates, first/returning, order value + currency, country,
language, sample are all evaluated inside `matchesTargeting`.

- **⚠ differs** — plan Phase 4 preferred delivery of the compiled config through
  an app-owned shop **metafield** read directly by the extension. That metafield
  declaration syntax could not be verified offline, so the plan's explicit
  fallback (**in-memory cache + `GET /api/survey`**) shipped. Recorded in
  `FUTURE_TASKS.md`. No behavioural difference for the buyer.
- **⚠ differs** — the plan's `plan_unsupported` config gate was deliberately not
  implemented. Shopify only runs the block on plans that support it, so our own
  plan reading could only ever hide the survey wrongly. `checkoutSupported`
  drives an admin banner only. Documented in `api.survey-config.tsx`.

---

## 2. Submit a response

```mermaid
flowchart TD
  A["POST /api/survey-responses"] --> B["authenticate.public.checkout()\nshop = token.dest"]
  B --> C["readBodyText(max 16 KB)"]
  C --> D["JSON.parse + zod bodySchema"]
  D --> E["per-order token bucket\n+ shop backstop + per-token jti cap"]
  E --> F["findShopByDomain(dest)"]
  F --> G["getSurveyRow(shopId, surveyId)\n(null ⇒ 400)"]
  G --> H["submitAnswers()\nvalidateResponse(definition, answers)"]
  H -- issues --> INVALID["400 with issues\n(stop retrying)"]
  H -- ok --> I["getUsageCount + evaluateCap\n(decides shouldLock)"]
  I --> I2["isCountableOrder(orderId) ⇒ verified\norderTotalFor ⇒ real total or null"]
  I2 --> J["transaction: create Response + Answers\n+ increment BillingUsage\n+ bump Survey.responseCount"]
  J --> K{"unique violation\n(P2002)?"}
  K -- yes --> DUP["200 {ok:true, counted}\nduplicate is success"]
  K -- no --> L["atomic claimUsageSlot\n(conditional update)"]
  L --> M["after-commit: enqueueSync + processPendingSync\n(Phase 7, off unless configured)"]
  M --> N["200 {ok:true, counted}"]
```

| Decision | File / function |
|---|---|
| Auth, size cap, body schema | `app/routes/api.survey-responses.tsx` |
| Rate limits + per-token cap | `app/lib/rate-limit.server.ts` (`consumeTokenSubmission`) |
| Validation | `shared/survey-rules.ts` → `validateResponse` |
| Verification snapshot | `app/lib/answers.server.ts` → `isCountableOrder`, `orderTotalFor` |
| Cap + write | `app/lib/answers.server.ts` → `submitAnswers`, `claimUsageSlot` |
| Duplicate rule | `submitAnswers` (`isUniqueViolation`) |
| Sync (Phase 7) | `app/lib/sync.server.ts` → `enqueueSync`, `processPendingSync` |

- **✅ implemented (was ⚠ differs)** — the `Response.verified` /
  `unverifiedFailed` columns ship (migration
  `20261012140000_response_verification`). A known, countable order is
  `verified = true`; `upsertOrderCache` reconciles a late order and stores the
  real total; `markUnverifiedFailedResponses` flips the rest after 24 h; revenue
  counts verified orders only and `unverifiedFailed` rows are excluded. Historic
  rows read `verified = NULL` and keep the legacy "total present decides"
  behaviour.
- **✅ implemented (was ⚠ differs)** — the per-token `jti` submission limiter
  (`MAX_SUBMISSIONS_PER_TOKEN = 2`) is in place, checked before any DB read.

---

## 3. Save or activate a survey (admin)

```mermaid
flowchart TD
  A["POST /app/surveys/:id (save)"] --> B["authenticate.admin + ensureShop"]
  B --> C["parse JSON blob (SurveyInput)"]
  C --> D["updateSurvey()"]
  D --> E["assertValid(validateSurveyDefinition)\ninline errors on failure"]
  E --> F["transaction: upsert questions/options,\ndelete removed when no answers\nelse archive"]
  F --> G["bump version on active save"]
  G --> H["invalidateConfig(shopId)\n(drops in-memory compiled cache)"]
  H --> I["redirect ?saved=1"]

  J["POST /app/surveys (activate)"] --> K["setSurveyStatus()"]
  K --> L{"activating?"}
  L -- yes --> M{"has questions and placements?"}
  M -- no --> N["400 inline error"]
  M -- yes --> O["status=active + invalidateConfig"]
```

| Decision | File / function |
|---|---|
| Route | `app/routes/app.surveys.$id.tsx`, `app/routes/app.surveys._index.tsx` |
| Validation | `shared/survey-rules.ts` → `validateSurveyDefinition`, wrapped by `app/lib/surveys.server.ts` → `assertValid` |
| Persistence + archiving | `app/lib/surveys.server.ts` → `persistQuestions`, `updateSurvey`, `setSurveyStatus` |
| Cache invalidation | `app/lib/surveys.server.ts` → `invalidateConfig` |

- **⚠ differs** — plan Phase 4 wanted a compiled-config **size check that blocks
  the save**. `getCompiledConfig` only **logs** `compiled_config_too_large`; the
  save is never blocked. Sizes are far below the limit in practice (16 KB). Left
  as a soft warning on purpose so a merchant is never locked out of saving.
- **⚠ differs** — plan Phase 4 wanted a metafield write on save. Not done (same
  reason as flow 1).

---

## 4. Plan check

```mermaid
flowchart TD
  A["Every page/route"] --> B["effectivePlan(shop)"]
  B --> C{"isPlanKey(shop.plan)\nAND planStatusIsCollecting(status)?"}
  C -- no --> FREE["free"]
  C -- yes --> STORED["stored plan"]

  D["GET /app/plans"] --> E["fetchActiveSubscriptions()\nAdmin GraphQL appInstallation"]
  E --> F["paidPlanFromSubscriptions()\nname startsWith sourcetrac, ACTIVE,\nnon-test in production"]
  F --> G["null ⇒ free"]
  G --> H{"needsPlanSync?"}
  H -- yes --> I["setPlan(plan, status=free?expired:active)"]

  J["app_subscriptions/update webhook"] --> K["matchPlanByDisplayName"]
  K --> L["isIgnoredTestCharge (production)"]
  L --> M["ignored if superseded\n(gid != subscriptionGid)"]
  M --> N["setPlan(...)"]
```

| Decision | File / function |
|---|---|
| Effective plan | `app/lib/plans.ts` → `effectivePlan`, `planStatusIsCollecting` |
| Cap | `app/lib/plans.ts` → `evaluateCap`, `currentUtcPeriod` |
| Partner-API read | `app/lib/billing.server.ts` → `fetchActiveSubscriptions`, `paidPlanFromSubscriptions` |
| Reconcile on load | `app/routes/app.plans.tsx` → `loader` |
| Webhook path | `app/lib/webhooks.server.ts` → `applySubscription`, `normaliseSubscriptionStatus` |

What each plan unlocks is in `app/lib/plans.ts` (`PLANS[].features`). Downgrade
keeps all data; extra surveys are not deleted.

- **⚠ differs** — the plan (Appendix 1) describes **Shopify App Pricing** with
  plan handles `free`/`growth`/`pro` and a Partner API `activeSubscription`
  token, and explicitly says the app must **not** call `appSubscriptionCreate`.
  The shipped app uses the **Billing API** (`appSubscriptionCreate`) with plans
  `free`/`growth`/`scale` and no Partner API token — see flow-4 table and
  `AUDIT_AND_PLAN.md` §8, which records that Billing already existed when the
  upgrade began. The table columns differ (`pro` vs `scale`), the enforcement
  points are equivalent. Full reconciliation in `COMPLIANCE_MATRIX.md`
  (Appendix-1 rows, status 🔁).

---

## 5. Pending sync retry (Phase 7)

```mermaid
flowchart TD
  A["After a response is stored"] --> B["enqueueSync(shopId, responseId, options)\none row per kind: tags/customer/metafield/flow"]
  B --> C["processPendingSync(shopId, 5) — inline"]
  C --> D["findMany(due, attempts<5, orderBy createdAt)"]
  D --> E{"row for each"}
  E --> F["loadSyncContext\n(response + survey + channel)"]
  F -- gone --> G["delete row"]
  F -- ok --> H["runSyncKind\n(canSync gates on granted scope)"]
  H -- ok --> I["delete row"]
  H -- error --> J["attempts+1\nnextAttemptAt = now + 2^attempts (cap 5 min)"]
  K["Dashboard load"] --> L["maybeRunPendingSync (≤ once / 5 min)"]
```

| Decision | File / function |
|---|---|
| Triggers | `app/lib/answers.server.ts` (inline), `app/routes/app._index.tsx` (`maybeRunPendingSync`) |
| Batch + backoff + give-up | `app/lib/sync.server.ts` → `processPendingSync` (MAX_SYNC_ATTEMPTS = 5) |
| Scope gate | `app/lib/scopes.server.ts` → `canSync` |
| Example worker | `tests/unit/sync-pending.test.ts` |

Status: implemented as the plan describes.

---

## 6. Results loading

```mermaid
flowchart TD
  A["GET /app/results"] --> B["authenticate.admin + ensureShop"]
  B --> C["backfillMissingOrders (bounded)"]
  C --> D["listSurveys → pick ?survey or first"]
  D --> E["getSurveyRow"]
  E --> F["fetchSurveyResponses(shopId, surveyId)\nLEFT-join OrderCache on (shopId, orderId)"]
  F --> G["summariseSurvey + buildBreakdowns"]
  G --> H["revenue decided by decideSurveyRevenue\n→ evaluateResponseRevenue"]
```

| Decision | File / function |
|---|---|
| Route | `app/routes/app.results.tsx` |
| Query | `app/lib/survey-analytics.server.ts` → `fetchSurveyResponses` |
| Revenue | `app/lib/survey-analytics.server.ts` → `decideSurveyRevenue` → `app/lib/revenue.ts` |
| Stats | `summariseSurvey`, `buildBreakdowns` |

- **⚠ differs** — the plan wanted the unfiltered (daily totals) path to read
  `SurveyDailyStats`. `SurveyDailyStats` is created by the schema/migration but is
  **not read or written** by any route today; every page reads raw `Response`.
  The table is unused, not wrong. Deferred in `FUTURE_TASKS.md`.

---

## 7. Privacy flows

```mermaid
flowchart TD
  A["POST /webhooks"] --> B["authenticate.webhook (HMAC)"]
  B --> C["claimWebhook (insert-first idempotency)"]
  C --> D{"topic"}
  D -- customers/data_request --> E["handleDataRequest\npersist DataRequest row (30d)"]
  D -- customers/redact --> F["handleCustomerRedact"]
  F --> G{"orders > 200?"}
  G -- yes --> H["inline first 200;\nstore remainder in PendingDeletion"]
  G -- no --> I["deleteOrdersForShop"]
  D -- shop/redact --> J["handleShopRedact\ndelete sessions + shop (FK cascade)"]
  D -- app/uninstalled --> K["clearAccessToken\n(null token, plan→free, keep data)"]
  L["Dashboard load"] --> M["maybeRunPendingDeletions\n(drain ≤ 5 batches)"]
```

| Decision | File / function |
|---|---|
| Route + idempotency | `app/routes/webhooks.tsx`, `app/lib/webhooks.server.ts` → `claimWebhook` |
| Handlers | `app/lib/compliance.server.ts` → `handleDataRequest`, `handleCustomerRedact`, `handleShopRedact` |
| Lazy drain | `app/lib/compliance.server.ts` → `processPendingDeletions`, `maybeRunPendingDeletions` |
| Uninstall | `app/lib/shop.server.ts` → `clearAccessToken` |

Status: implemented. Idempotency is layered on the ledger and each handler is
safe to run twice.

---

## 8. Data retention cleanup

```mermaid
flowchart TD
  A["webhook route (DB already awake)"] --> B["maybeRunRetention\n(≤ once / 24h per process)"]
  C["POST /jobs/retention"] --> D["runRetentionPurge"]
  B --> D
  D --> E["webhook_events < 30d"]
  D --> F["SurveyResponse/Response/Answer/Stats < 24mo"]
  D --> G["OrderCache < 24mo AND unreferenced"]
  D --> H["DataRequest < 30d"]
  D --> I["PendingDeletion < 24mo"]
```

| Decision | File / function |
|---|---|
| Schedule | `app/routes/webhooks.tsx` (`void maybeRunRetention()`), `app/routes/jobs.retention.ts` |
| Purge | `app/lib/retention.server.ts` → `runRetentionPurge` |
| Totals stay correct | orders kept while any response still references them |

Status: implemented. Note the tenant-scoping caveat in `AUDIT_REPORT.md` F-007
(cleanup is global, not per-shop, though every window is uniform).

---

## 9. Bonus features (flags off)

```mermaid
flowchart TD
  A["FEATURE_FLAGS"] --> B{"ONSITE_SURVEYS?"}
  B -- false --> C["no nav, no route, no config"]
  A --> D{"SURVEY_LINK_PAGE?"}
  D -- false --> C
```

| Decision | File / function |
|---|---|
| Flags | `shared/feature-flags.ts` → `FEATURE_FLAGS` |
| Read by | `app/routes/app.settings.tsx` (status only) |

Both are **off**; the `onsite` and `link` placements exist in the type union but
no route renders them. Nothing in `app/` branches on the flags beyond Settings.

---

## 10. Logic map builder (admin, Phase G)

```mermaid
flowchart TD
  A["app.surveys.$id.tsx\nview state: questions | logic"] --> B{"view === logic?"}
  B -- no --> Q["question editor"]
  B -- yes --> C["buildLogicTree(survey definition)\nshared/logic-tree.ts"]
  C --> D["computeReachable()\nreachable set"]
  C --> E["per question: conditionFor()\n+ describeCondition()"]
  C --> F["attach to parent by showIf.questionId\nisAncestorSafe() guards cycles"]
  F --> G["nodeWarnings():\nunreachable / removed_option /\nrequired_conditional"]
  G --> H["LogicMap component\napp/components/logic-map.tsx"]
  H --> I["tree (s-section/s-stack/s-badge)\n+ warnings"]
  H --> J["Try-it-as-a-shopper simulator\nsame isQuestionVisible"]
  H --> K["Add follow-up / Edit rule modals\n(only earlier questions offered)"]
  K --> L["mutates shared editor state\n⇒ save bar appears"]
```

| Decision | File / function |
|---|---|
| Builder (pure) | `shared/logic-tree.ts` → `buildLogicTree` |
| Reachability | `computeReachable` |
| Condition labels | `conditionFor`, `describeCondition`, `resolveOptionLabel` |
| Warnings | `nodeWarnings`, `allowedOptionIds` |
| Reachability guard | `isAncestorSafe` |
| UI | `app/components/logic-map.tsx` |
| Editor wiring | `app/routes/app.surveys.$id.tsx` (`view` state, anchors) |
| Simulator visibility | `@shared/survey-rules` → `isQuestionVisible` |

No ⚠ differs markers: the map is additive and does not touch the checkout
extension bundle.

