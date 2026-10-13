# Compliance matrix — SourceTrac vs the upgrade plan

Created during the logic/security/completeness audit (Phase B).

**Rule applied:** where the plan and the code disagree, the code wins, and the
disagreement is written down (🔁). This codebase is the source of truth; the
upgrade plan (`survey-app-upgrade-plan.md`) was not vendored into the repo, so
the requirements below are taken from the audit brief, `AUDIT_AND_PLAN.md`'s
own extraction of the plan, and Appendix 1 of the audit instructions.

Status legend: ✅ Done · 🟡 Partial · ❌ Missing · 🔁 Changed on purpose · ⏭ Skipped.

---

## A. Core feature map (1–30) and bonuses

| ID | Requirement | Source | Status | Evidence | Notes |
|---|---|---|---|---|---|
| F1 | Multi-question surveys (up to 5) | upgrade plan §core | ✅ | `shared/survey-rules.ts` `LIMITS.MAX_QUESTIONS=5`; `tests/unit/survey-rules.test.ts` | |
| F2 | Question types: single, multi, dropdown, yes/no, rating, satisfaction, NPS, text | §core | ✅ | `shared/survey-rules.ts` `QUESTION_TYPES`; `tests/unit/survey-rules.test.ts` | |
| F3 | Required questions | §core | ✅ | `SurveyQuestionDef.required`; validated in `validateResponse` | |
| F4 | Optional "Other (please specify)" | §core | ✅ | `allowOther`; `OTHER_CHANNEL_VALUE`; `tests/unit/other-answer.test.ts` | |
| F5 | Min/max selections for multi-choice | §core | ✅ | `validateResponse`; `tests/unit/survey-rules.test.ts` | |
| F6 | Show-if logic (choice + numeric ranges, chains) | §core | ✅ | `isQuestionVisible`; `tests/unit/survey-rules.test.ts` | |
| F7 | Randomize option order, "Other" always last | §core | ✅ | `surveyChoices`/shuffle; `tests/unit/survey-rules.test.ts:202` | |
| F8 | Survey list with priority order | §core | ✅ | `app/routes/app.surveys._index.tsx`; `reorderSurveys` | |
| F9 | Duplicate / pause / activate / delete | §core | ✅ | `app.surveys._index.tsx` actions; `surveys.server.ts` | |
| F10 | Templates (12) | Appendix A | ✅ | `shared/survey-templates.ts` (12 entries); `tests/unit/survey-templates.test.ts` | |
| F11 | Placements: thank-you + order-status | §core | ✅ | `PLACEMENTS`; both extension dirs | |
| F12 | Checkout UI extension (Preact, api 2026-07) | §core | ✅ | `extensions/sourcetrac-thank-you`; `tests/integration/extension-bundle.test.ts` | |
| F13 | Customer Account UI extension | §core | ✅ | `extensions/sourcetrac-order-status` | |
| F14 | Admin order/customer blocks | Phase 7 | ✅ | `extensions/sourcetrac-*-admin`; `api.admin-survey-context.tsx` | |
| F15 | Results page (aggregates, trends) | §core | ✅ | `app/routes/app.results.tsx`; `app/lib/analytics.ts` | |
| F16 | Responses page (raw answers, linked to order) | §core | ✅ | `app/routes/app.responses.tsx`; `PAGE_SIZE=50` | |
| F17 | Revenue by channel | §core | ✅ | `rollupByCurrency`; `app/routes/app.results.tsx` | |
| F18 | AOV, response rate, NPS, avg rating | §core | ✅ | `app/lib/analytics.ts`; `tests/unit/analytics.test.ts` | |
| F19 | CSV export (BOM, escaping, shop tz) | §core | ✅ | `app/lib/csv.ts`; `app/routes/app.export_.csv.tsx`; `tests/unit/survey-csv.test.ts` | Row cap added in this audit |
| F20 | Targeting: dates, sample %, order value, country, language, customer type | §core | ✅ | `matchesTargeting`; `tests/unit/survey-targeting.test.ts` | |
| F21 | Product/collection targeting | §core | 🟡 | `Targeting.productIds` exists; UI note only | Picker deferred — `FUTURE_TASKS.md` (needs live shopify.dev) |
| F22 | Translations (10 locales) | §core | ✅ | `app/lib/i18n/locales/*`; extension `locales/`; `tests/unit/i18n.test.ts` | |
| F23 | Plan gating (Free/Growth/Scale) | Appendix 1 | ✅ | `app/lib/plans.ts`; `effectivePlan` | |
| F24 | Free cap: 1 survey, 2 questions, 100/mo | Appendix 1 | 🔁 | `shared/plans.ts`; `app/lib/answers.server.ts` `claimUsageSlot` | Code enforces `FREE_RESPONSE_CAP=50` server-side (atomic) and applies global `MAX_ACTIVE_SURVEYS=10` / `MAX_QUESTIONS=5` to all plans. At the cap it **keeps collecting** and flags rows, prompting in the admin — it does not hide the survey from buyers (deliberate: never lose buyer data). See F-010 |
| F25 | Billing via Shopify App Pricing (no appSubscriptionCreate) | Appendix 1 | 🔁 | `billing.server.ts` still holds the Billing API path | `AUDIT_AND_PLAN.md` records App Pricing as the live model; the legacy API path is unreferenced by admin routes |
| F26 | Billing redirect breaks out of iframe | §prod fixes | ✅ | `app/routes/app.plans.tsx` `target:"_top"` | |
| F27 | Shopify sync (tags, metafields, Flow) | Phase 7 | ✅ | `app/lib/sync.server.ts`; scope-gated via `canSync` | Size/tag guards added in this audit |
| F28 | PendingSync retry with backoff | Phase 7 | ✅ | `processPendingSync`; `MAX_SYNC_ATTEMPTS` | |
| F29 | GDPR webhooks | §compliance | ✅ | `app/routes/webhooks.tsx`; `compliance.server.ts` | |
| F30 | Retention cleanup | §compliance | ✅ | `maybeRunRetention`; `jobs.retention` | |
| B1 | On-site survey block | Bonus | ⏭ | `shared/feature-flags.ts` `ONSITE_SURVEYS=false` | Flag off by design |
| B2 | Survey link page (App Proxy) | Bonus | ⏭ | `SURVEY_LINK_PAGE=false` | Flag off by design |

## B. Non-negotiable rules (plan §2)

| ID | Rule | Status | Evidence |
|---|---|---|---|
| R1 | Never break checkout; survey fails silently | ✅ | Extension retry+hide; `tests/integration/extension-bundle.test.ts` |
| R2 | Never touch the merchant's theme | ✅ | No Asset API writes (`grep` clean) |
| R3 | No new infra / paid services / AI / email | ✅ | No new deps added in this audit |
| R4 | Extension < 64 KB | ✅ | `check:extensions`; bundles built |
| R5 | Flow payload < 50 KB | ✅ | `MAX_FLOW_PAYLOAD_BYTES=45_000` (added this audit) |
| R6 | Webhooks answer < 5 s | ✅ | Retention deferred inline batch; `REDACT_BATCH_SIZE` |
| R7 | Shopper survey causes zero DB queries | ✅ | Config cached; `tests/integration/extension-bundle.test.ts` |
| R8 | Don't rename handles/targets/columns | ✅ | Handles unchanged |
| R9 | In-memory rate limiting, no new deps | ✅ | `rate-limit.server.ts` |
| R10 | Never sum revenue across currencies | ✅ | `sumByCurrency`/`rollupByCurrency` |
| R11 | UTC period boundaries, half-open | ✅ | `currentUtcPeriod` |

## C. Limits budget

| Item | Budget | Status | Evidence |
|---|---|---|---|
| Extension bundle | < 64 KB | ✅ | `check:extensions` passes |
| Flow payload | < 50,000 B | ✅ | `truncateForPayload` + guard |
| Webhook response | < 5 s | ✅ | bounded batch |
| CSV rows | cap | ✅ | `MAX_CSV_ROWS=50_000` (added) |
| Responses page size | ≤ 50 | ✅ | `PAGE_SIZE=50` |
| Service pg size < 0.5 GB | ✅ | Retention |

## D. Shared rules module

| Requirement | Status | Evidence |
|---|---|---|
| `LIMITS` constants | ✅ | `shared/survey-rules.ts` |
| `isQuestionVisible` | ✅ | tested |
| `validateSurveyDefinition` / `validateResponse` | ✅ | tested |
| `showIfOptionIds` | ✅ | `tests/unit/survey-rules.test.ts` |
| `buildLogicTree` (new, Phase G) | ✅ | `shared/logic-tree.ts`; `tests/unit/logic-tree.test.ts` |

## E. Data model (Appendix C)

| Requirement | Status | Evidence |
|---|---|---|
| `Response` unique `(shopId, surveyId, orderId)` | ✅ | `prisma/schema.prisma:400` |
| `Verified` / `unverifiedFailed` columns | ✅ | migration `20261012140000_response_verification` |
| Money columns `Decimal(18,3)` | ✅ | schema |

## F. Templates (Appendix A)

12 templates present, each with the plan's question types, required flags and a
channel-report question where specified. `tests/unit/survey-templates.test.ts`
pins structure. Show-if rules were fixed for `did-you-compare` and
`first-time-vs-returning` in an earlier pass (`showIfOptionIds`). ✅

## G. Design rules

| Area | Requirement | Status | Evidence |
|---|---|---|---|
| Admin | Each `s-app-nav` item exactly: Surveys, Results, Responses, Settings, Help | ✅ | `app/routes/app.tsx` NAV |
| Admin | One-line description under each page title | ✅ | see Phase H pass |
| Admin | Contextual save bar | ✅ | `app.surveys.$id.tsx` |
| Admin | Inline field errors | ✅ | `extractIssues`/`errorId` |
| Admin | Empty states | ✅ | surveys list, responses |
| Admin | Advanced sections collapsed | ✅ | `AdvancedDisclosure` in `app/components/admin-ui.tsx`; targeting advanced block in `app.surveys.$id.tsx` | Sample %, countries, languages, dates and response limit sit under a collapsed "Advanced" |
| Shopper | Native look, mobile tap targets | ✅ | Polaris web components; preview |
| Shopper | After-submit confirmation | ✅ | thank-you text |

## H. Acceptance checks per phase

Phase 1–8 acceptance checks are met per `AUDIT_AND_PLAN.md`; this audit added the
verification/abuse items. See `AUDIT_REPORT.md`.

---

## I. Templates, Insight Library and Survey Studio (T1-T16, S1-S13)

Source: `templates-and-studio.md`. Six phases committed on `main`
(`Phase 0-1` through `Phase 5`), plus the Phase 6 Overview/Results/Home pass.
Where the plan and the code disagree, the code wins; divergences are recorded in
`TEMPLATES_NOTES.md`.

### Templates and insights

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| T1 | Insight library: categories, search, filters, outcome tags | DONE | `app/routes/app.surveys.library._index.tsx`; `shared/templates/catalog.ts`; `tests/unit/templates-catalog.test.ts` |
| T2 | Template detail: learn, questions, logic, preview, example results, ideas | DONE | `app/routes/app.surveys.library.$id.tsx` |
| T3 | Quick setup (3 steps) | DONE | `app/routes/app.surveys.library.$id.setup.tsx`; `shared/templates/setup.ts`; `tests/unit/templates-setup.test.ts` |
| T4 | Answer packs (region / occasion / industry) | DONE | `shared/templates/packs.ts`; locale keys `packs.*` |
| T5 | Lite versions | DONE | `template.liteQuestionKeys`; `buildSurveyDefinition({ lite })`; catalog `hasLite` |
| T6 | Exclusive answer option | DONE | `Option.exclusive` (migration `20261012160000`); server rejection as `exclusive_with_others` in `shared/survey-rules.ts`; clearing rule shared by the admin preview (`reconcileMultiChoiceSelection`) and checkout (`applyExclusiveToggle`), pinned by `tests/unit/exclusive-option.test.ts` |
| T7 | Payment-method targeting | PARTIAL | `shared/survey-config.ts`; extension reads `selectedPaymentOptions`, empty = not matched. Unverified on shopify.dev from this container (see `TEMPLATES_NOTES.md`) |
| T8 | Results by product | DONE | `Response.productIds`; `buildProductBreakdown`; `ProductTable`; `getProductTitles` cache |
| T9 | Confidence meter | DONE | `shared/templates/confidence.ts`; `ConfidenceBadge` / `ConfidenceHelp`; boundaries tested in `tests/unit/templates-stats.test.ts` |
| T10 | Learn & stop | DONE | `Survey.learnAndStop`; trigger in `app/lib/answers.server.ts` |
| T11 | Insight rotation | DONE | `Survey.rotation` / `rotationWeight`; `shared/survey-config.ts` selection; `app/lib/surveys.server.ts` |
| T12 | Ideas to try | DONE | `shared/templates/ideas.ts`; `app/lib/insights.server.ts`; `IdeasList` |
| T13 | Smart actions | DONE | `shared/templates/smart-actions.ts`; pending-retry sync in `app/lib/sync.server.ts`; scope-gated |
| T14 | Cross-question view | DONE | `buildCrossTab` / `crossTabRowShares`; `CrossTabView`; key resolution in `app/lib/insights.server.ts` (guarded by `tests/unit/insights-build.test.ts`) |
| T15 | Seasonal spotlight | DONE | `shared/templates/seasons.ts`; `currentSpotlight`; Home next-step |
| T16 | Minimal home | DONE | `app/routes/app._index.tsx`; `app/lib/home.server.ts` |

### Survey Studio

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| S1 | Three-panel Studio (responsive) | DONE | `app/routes/app.surveys.$id.tsx` |
| S2 | Realistic preview (shop name, currency, product) | DONE | `app/components/checkout-mock.tsx`; `getShopDisplay` |
| S3 | Placement switcher | DONE | Studio preview tabs |
| S4 | Device switcher | DONE | desktop / mobile frames |
| S5 | Interactive preview | DONE | shared `isQuestionVisible` / `validateResponse` in `app/components/survey-preview.tsx` |
| S6 | Click to edit | DONE | preview selects the question in the editor |
| S7 | Drafts for live surveys | DONE | `Survey.draft` / `draftUpdatedAt`; publish/discard transactions |
| S8 | Change summary | DONE | `diffSurvey`; publish modal |
| S9 | Ready check | DONE | `shared/templates/readiness.ts`; `getReadiness` |
| S10 | Preview in Shopify's checkout editor | PARTIAL | Fallback "Open checkout editor" link wired under the Studio preview (`app/routes/app.surveys.$id.tsx`). The plan's metafield mechanism does not fit: config is served over HTTP, and the editor has no order id. `shopify.extension.editor` detection exists and is used — see `TEMPLATES_NOTES.md` Phase 7 |
| S11 | Design tab | DONE | `DesignSettings` in `shared/survey-rules.ts`; Studio Design panel |
| S12 | Scale labels | DONE | `scaleLowLabel` / `scaleHighLabel`, max 30 chars |
| S13 | Preview language | DONE | Studio locale select; survey translations |

Status legend for this table: DONE / PARTIAL (built defensively, gap recorded).

---

## Open items feeding Phase F

- **F-010** — Free plan limits: the plan says 100 responses/mo and 1 active
  survey / 2 questions; the code enforces `FREE_RESPONSE_CAP = 50` server-side
  and does **not** enforce the survey/question counts server-side. Either bring
  the constant to 100 and add count enforcement, or record the divergence.
- **F-011** — Advanced options are not yet grouped under a collapsed
  "Advanced" disclosure (Phase H item).
- **F-021** — Product/collection targeting picker (deferred, needs live docs).
