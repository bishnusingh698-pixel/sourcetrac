# Production-readiness pass (2026-11-06)

Four jobs, in priority order: a bug audit, a Shopify compliance audit, a
visual polish of the admin, and a 14-day free trial on both paid plans.

## How this was checked

- **Baseline** (before any change): `npm run check` green, 110 files / 1,409
  tests against real Postgres 18 (embedded), ~90 s; `npm run build` clean (only
  React Router v8 future-flag notices); `grep -o "process\.env\.[A-Z_]*"
  build/client/assets/*.js` empty. There is no linter; the two type checkers and
  `check:extensions` are the static checks.
- **After**: 119 files / 1,449 tests green, build clean, no `process.env` in the
  client bundle, both checkout bundles ~17 KB compressed.
- **New harnesses** so flows are tested through their real entry points, not
  their helpers:
  - `tests/helpers/admin-request.ts`: an admin page driven through the
    library's own `authenticate.admin` (an App Bridge id token signed with the
    app secret, plus a stored offline session). No earlier test reached an
    admin loader or action this way.
  - `tests/helpers/checkout-request.ts`: a checkout extension request with a
    signed session token, browser UA and cross-origin Origin.
  - `tests/db-store-simulation.test.ts`: one store end to end. Quick start
    (admin action) creates the survey; buyers load and answer it (checkout
    routes) with orders arriving before and after the answer, in USD, JPY and
    KWD, plus a test order and a refunded one; then Analytics › Channels, Home,
    Survey results, Responses and both CSVs are read back and must agree.
  - Every admin loader was also smoke-run on a brand-new store with nothing in
    it: none throws.
- **Shopify sources**: `shopify.dev` does not resolve from this container, for
  `curl` or the fetch tool (`getaddrinfo ENOTFOUND`). Rules were verified on
  2026-11-06 through web search of shopify.dev pages (URLs in the compliance
  table), and field names against Shopify's own `@shopify/shopify-api` v15
  source in `node_modules`, which supports `ApiVersion.July26 = "2026-07"` and
  sends `appSubscriptionCreate(trialDays:, replacementBehavior:)` and reads
  `AppSubscription { trialDays createdAt currentPeriodEnd }`
  (`lib/billing/request.ts`, `lib/billing/types.ts`). Where neither source
  settled a rule it is marked **unverified**.

Severity: **critical** = data loss, wrong money, broken checkout or a security
hole; **major** = a flow a merchant or buyer cannot complete, or a Shopify
requirement failed; **minor** = wrong but recoverable, cosmetic, or copy.

## Findings

| Id | Sev | File:line | Root cause | Status | Commit |
| --- | --- | --- | --- | --- | --- |
| P1 | major | `app/lib/shopify-graphql.server.ts:68`, `:104` | A `THROTTLED` answer was retried after a random 0–500 ms jitter whatever the bucket held, and nothing slowed a run of calls before the bucket emptied. Shopify's rate-limit page asks clients to read `extensions.cost.throttleStatus`. Now a throttled retry waits `(requestedQueryCost − currentlyAvailable) / restoreRate` (capped at 4 s), and the next call to a shop pauses while its bucket is under 10% of `maximumAvailable`. | fixed | 7583913 |
| P2 | major | `app/routes/webhooks.tsx:162` | Shopify fails a delivery not answered within 5 s. A billing notice made up to two Admin API calls (20 s timeout × 4 attempts) before replying; a redact or order write could wait on Neon waking. The route now races the work against 4.5 s and answers 503 past it; the work still finishes and records itself, so Shopify's retry finds it done (200) or in flight (503). | fixed | 4d0161e |
| P3 | major | `app/routes/app.tsx:187` (was `app/components/top-nav.tsx`) | The body drew a grid of every app page, a copy of `<s-app-nav>`. Shopify's design guidelines say not to replicate the app nav in the app body; Built for Shopify lists an app's own navigation menu as an audit failure. | fixed (see UI) | 6ac2293 |
| P4 | minor | `app/routes/app.plans.tsx` (`yearly_note`) | The page said every downgrade waits for the end of the billing period. Shopify's `STANDARD` replacement defers only yearly → cheaper yearly and yearly → monthly; every other change, a monthly downgrade included, applies on approval. Copy corrected in ten languages. (DECISIONS M14's wording had the same error.) | fixed | 811f9f3 |
| P5 | minor | `app/routes/app.plans.tsx` (scheduled-change banner) | The date was formatted in the component with `toLocaleDateString(language)`: the server's zone on render and the browser's on hydration (a mismatch warning, and possibly a different day), and the language rather than the merchant's region. Dates are now formatted in the loader in the store's zone and regional format. | fixed | 5fb71f3 |
| P6 | minor | `app/routes/app._index.tsx:91` | Home resolved template names from the saved language only, so a merchant who never picked one saw an English template name inside a translated sentence ("Starten Sie mit How did you hear about us?"). Uses the page's resolved language now. `tests/db-admin-routes.test.ts`. | fixed | 95ae8d7 |
| P7 | minor | `app/components/admin-ui.tsx` (`RangeSwitcher`), `app.surveys.library._index.tsx`, `app.plans.tsx` | The selected date range, template goal and billing cycle were painted as primary buttons, so report pages carried a "primary action" that was a filter (Polaris: one primary action per page). Now one shared segmented control. | fixed | cddb342 |
| P8 | minor | `app/routes/app.tsx` (cap banners), `app/components/channel-report.tsx` | Upgrade prompts used primary buttons (Built for Shopify: no pushy upgrade prompts). Plain buttons now. | fixed | cddb342 |
| P9 | minor | `app/components/page-loading.tsx:19` | Nothing showed a page switch had registered while the next loader ran (seconds on Home behind Shopify calls). The admin's own progress bar now runs (App Bridge Loading API). | fixed | cddb342 |
| P10 | minor | several components | Icons drawn at two sizes beside text; Results' tables printed counts ungrouped and in proportional figures. | fixed | cddb342 |
| P11 | minor | `app/routes/app.plans.tsx` | (Found while building the trial.) The billing panel would have told a store that already used its trial that plans "start with a 14-day free trial". Shown only while a trial is on offer or running. | fixed | 1162390 |

Every fix has a test that fails on the old code (revert, run, restore):
`tests/unit/graphql-throttle.test.ts` (P1), `tests/db-webhook-budget.test.ts`
(P2), `tests/unit/top-nav.test.ts` (P3), `tests/db-admin-routes.test.ts` (P6),
`tests/unit/ui-polish.test.tsx` (P7, P8, P10), `tests/unit/page-loading.test.ts`
(P9), `tests/unit/plans-trial-render.test.tsx` (P11). P4 and P5 are copy and
formatting; P5 is covered by the trial render test's server-formatted dates.

### Checked and found sound (no change)

- **Store lifecycle end to end** (simulation above): the same answer count,
  revenue per currency (USD, JPY zero-decimal, KWD three-decimal), AOV and CSV
  rows on every screen; answer-before-order reconciles; test and refunded orders
  count as answers but not revenue; a second load of an answered order hides
  the survey.
- **Per-shop isolation**: another shop's survey id in `?survey=` on Results,
  Responses or the Results CSV is never served (now pinned in
  `tests/db-admin-routes.test.ts`); extension routes take the shop from the
  token's `dest` only.
- **CSV formula injection**: every export path (`toCsv`, `tableToCsv`) goes
  through `escapeCsvValue`, which neutralises `= + - @`.
- **Memory on Render's 512 MB**: every process-level cache (`rate-limit`,
  `order-verify`, `devStoreCache`, `studio` caches, `configCache`, the new
  throttle map) is bounded or pruned.
- **Query cost**: the largest query is `orders(first: 100) { nodes { id } }`
  (~102 points); all are far under the 1,000-point single-query maximum. The
  order backfill is capped (10 orders a run, one run per shop, each order at
  most hourly); the sync sweep takes 10 rows per shop every 5 minutes; product
  titles are one `nodes(ids:)` query of at most 100.
- **Links**: every in-app `href`/`to` resolves to a route.
- **Raw HTML**: the only `dangerouslySetInnerHTML` renders Shopify's own App
  Bridge auth page (documented in AGENTS.md).

Not reproduced, so not changed: nothing else from the flows in the brief failed
when driven through the harnesses (double submits, answer before order,
multi-currency, legacy rows, downgrade and cancel are covered by the existing
suite and re-ran green).

## Shopify compliance

Read 2026-11-06. "WS" = verified through web search of the shopify.dev page
named; "lib" = verified in Shopify's own library source.

| Shopify requirement | Where the app handles it | Result | Fix / note |
| --- | --- | --- | --- |
| Session tokens, no third-party cookies or local storage, works in incognito (App Store 1.1.1; WS: shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) | `app/shopify.server.ts:21` (`shopifyApp`, token exchange), `app/routes/app.tsx:105` | pass | localStorage holds no session; incognito not testable here (no admin) |
| Embedded with App Bridge (App Store requirements; BfS) | `app/routes/app.tsx` `AppProvider`, `tests/unit/app-bridge-wiring.test.ts` | pass | |
| Bill only through Shopify; Billing API ("Manual Pricing") is supported (WS: shopify.dev/docs/apps/launch/billing) | `app/lib/billing.server.ts:37` `appSubscriptionCreate` | pass | Partner Dashboard pricing must be set to manual/Billing API (Needs you) |
| Merchants change plan without contacting support or reinstalling (WS: app-store-requirements) | `app/routes/app.plans.tsx` subscribe/cancel/switch cycle | pass | |
| Plan-change timing as documented (`AppSubscriptionReplacementBehavior`, WS: shopify.dev/docs/api/admin-graphql/2026-07/enums/AppSubscriptionReplacementBehavior) | `app/routes/app.plans.tsx:448`, `yearly_note` | **fail → fixed** | P4; trial switches use `APPLY_IMMEDIATELY` |
| Price, trial and renewal shown before approval | `app/routes/app.plans.tsx` cards, `:563` banner | pass (new) | Job 4 |
| Test charges only where nothing real can be billed | `app/lib/billing.server.ts:208`, `:407` (`testChargesAllowed`) | pass | dev stores and non-production only |
| Free trial: Billing API `trialDays` (lib: `@shopify/shopify-api` `lib/billing/request.ts`) | `app/lib/billing.server.ts`, `app/lib/trial.server.ts:74`, `:99` | pass (new) | one per store tracked by the app (Shopify does not, for the Billing API) |
| GraphQL Admin cost-based throttling; 1,000-point single-query max; bucket/restore by plan (WS: shopify.dev/docs/api/usage/rate-limits) | `app/lib/shopify-graphql.server.ts:68`, `:104` | **fail → fixed** | P1 |
| No request loops that grow with data | `app/lib/order-backfill.server.ts:84`, `app/lib/sync.server.ts:658` | pass | capped and deduplicated |
| New code GraphQL only | all new calls | pass | no REST anywhere (`shopify-rest.server.ts` is GraphQL despite its name) |
| Webhooks HMAC-verified; 401 on bad HMAC | `app/routes/webhooks.tsx:40` (`authenticate.webhook`) | pass | |
| Webhook answered within 5 s; retried 8 times over 4 h (WS: shopify.dev/docs/apps/build/webhooks/troubleshoot) | `app/routes/webhooks.tsx:162` | **fail → fixed** | P2 |
| Webhooks idempotent | `app/routes/webhooks.tsx:61` (`claimWebhook`, insert-first) | pass | |
| Mandatory privacy webhooks; `shop/redact` 48 h after uninstall; act within 30 days (WS: shopify.dev/docs/apps/build/compliance/privacy-law-compliance) | `shopify.app.toml:37`; `app/lib/compliance.server.ts:65`, `:311`, `:617` | pass | redacts act inline or within the deferred drain |
| Every subscribed topic handled | `shopify.app.toml`, `normaliseWebhookTopic`, `tests/db-webhook-route.test.ts` | pass | |
| Admin nav: `s-app-nav`, past 7 items folded under "View more", one level, rel="home" (WS: shopify.dev/docs/apps/design/navigation) | `app/routes/app.tsx:187`, `app/lib/nav.ts` | pass | 6 visible items + home |
| Do not replicate the app nav in the body; own nav menu is a BfS audit failure (WS: shopify.dev/docs/apps/design/navigation; shopify.dev/docs/apps/launch/built-for-shopify/requirements) | was `app/components/top-nav.tsx` | **fail → fixed** | P3 |
| Tabs only for secondary navigation, sparingly (WS: BfS changelog "new Built for Shopify design requirements") | `app/components/section-tabs.tsx` | pass | three sections only |
| One page container | `app/routes/app.tsx:198` (only `s-page`) | pass | |
| One save bar at a time | `app/components/unsaved-changes.tsx:25` (single `SAVE_BAR_ID`, editor only) | pass | |
| One primary action per page (Polaris) | `Segmented` in `app/components/admin-ui.tsx` | **fail → fixed** | P7 |
| No pushy or misleading upgrade prompts (BfS) | cap banners, report note | **fail → fixed** | P8; no "most popular" / "2 months free" copy |
| Admin performance: LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms at p75 (WS: BfS requirements; Shopify changelog) | browser bundle English-only (~34 KB main chunk), shell loader not re-run on page switches | **unverified** | real Web Vitals only exist in the Partner/Dev Dashboard after installs |
| Accessibility (BfS; WCAG AA per third-party summaries only) | `aria-current`/`aria-pressed`, native `<details>`, 44 px touch targets in the new controls | **unverified** | the official BfS wording could not be read |
| Checkout/customer-account UI extension bundle ≤ 64 KB compressed (api 2025-10+; WS: shopify.dev/docs/apps/build/checkout/extension-performance/optimize-bundle-size) | `tests/integration/extension-bundle.test.ts` (new size guard) | pass | ~17 KB each |
| `network_access` declared; Partner Dashboard opt-in | `extensions/sourcetrac-thank-you/shopify.extension.toml:13`, `extensions/sourcetrac-order-status/shopify.extension.toml:13` | pass | opt-in is Needs you |
| Extensions use only the API's components, no custom styling | `extensions/shared/src/*` (no `style`/`className`) | pass | branding is inherited |
| Correct targets | `purchase.thank-you.block.render` (`:21`), `customer-account.order-status.block.render` (`:21`) | pass | |
| Block never blocks or slows the page | `extensions/shared/src/use-multi-survey.ts:257` (hides on failure, 8 tries / 60 s) | pass | |
| Order status needs new customer accounts | editor/Help copy | **unverified** | no shopify.dev page states it outright in the search results; copy kept |
| Only the data the app needs; protected customer data level 1 (no name/email/phone/address) (WS: shopify.dev/docs/apps/launch/protected-customer-data) | `tests/unit/data-notice.test.ts`, `app/routes/privacy.tsx` | pass | whether `write_customers` alone triggers the review is **unverified**; treated as yes |
| Privacy policy and in-app notice match the code | `app/routes/privacy.tsx:77`, `app/components/data-notice.tsx:91` | pass | trial record disclosed (new) |
| Retention timelines | `app/lib/retention.server.ts:27` | pass | |
| Only the four declared scopes | `shopify.app.toml:21`, `app/lib/env.ts:17`, `app/lib/scopes.server.ts:44` | pass | no scope added |
| Listing: pricing only in the pricing section, truthful, no statistics/claims (WS: app-store-requirements; best-practices) | `docs/07-deploy-and-submission.md` §4, `tests/unit/listing-copy.test.ts` | pass (rewritten) | prices and trial pinned to `app/lib/plans.ts` |

Left out because Shopify's rules do not allow it: none was attempted. Two
things stay impossible by design and were not worked around: colours or fonts
in the checkout block (branding is inherited), and a second save bar or page
container.

## UI changes

- **Navigation** (P3). Shopify's `<s-app-nav>` is the menu: the sidebar on
  desktop, the app title's menu on a phone. The body no longer repeats it.
  On the pages of Surveys, Analytics and Responses the shell draws one compact
  segmented row of that section's pages: small icon beside the label, the
  current page raised and `aria-current="page"`, 44 px tall items, wrapping on
  a phone (never scrolling or overlapping), React Router links (no full
  reloads). The survey editor shows Shopify's title-bar breadcrumb back to
  Surveys instead of an in-body link.
- **Selections** (P7): date ranges, template goals and the billing cycle share
  that segmented look, with `aria-current` / `aria-pressed`.
- **Upgrade prompts** (P8) are plain buttons; the Growth card's trial button is
  the Plans page's one primary action.
- **Loading** (P9): the admin's progress bar runs during page switches.
- **Consistency** (P10): one icon size; locale-grouped tabular counts.
- Checked statically only: `cdn.shopify.com` is blocked here, so Polaris does
  not render in a local browser. Components were rendered with React (SSR and
  happy-dom) and the CSS is pinned by tests.

## The 14-day trial

- **Charge**: `appSubscriptionCreate(trialDays:)` (`app/lib/billing.server.ts`).
  Shopify runs the trial: the first charge waits, its approval page shows the
  trial, and a subscription cancelled during it is never billed.
- **One per store, ever**: Shopify does not remember trials across Billing API
  subscriptions, so the app does. `TrialLedger` (migration
  `20261106090000_free_trial`, additive) holds one row per store that ever had
  a paid plan, keyed by SHA-256 of `"sourcetrac-trial:" + domain` and of the
  shop GID, **not linked to `Shop`**: uninstall, `shop/redact` and reinstall
  cannot reset it. Written once, from the first live subscription's own
  `createdAt` + `trialDays`, by the billing webhook or the Plans page
  (whichever sees it live first; a race keeps one row by the unique key).
- **Days on a new charge** (`remainingTrialDays`): 14 for a store with no row;
  the days left until the row's fixed end, rounded up to Shopify's whole days,
  for a switch of plan or cycle during the trial; 0 afterwards. Because the end
  never moves, repeated switching adds at most the part of one day the rounding
  gives. A plan bought before trials existed is recorded first (as a used
  trial), so switching from it never starts one.
- **Switching during the trial** uses `APPLY_IMMEDIATELY`: nothing was paid,
  so there is no period to wait out (STANDARD would defer yearly → monthly).
- **During the trial** the subscription is ACTIVE, so `effectivePlan`, the cap
  (none), plan gating and sync all treat it as the paid plan; nothing changed
  there. `Shop.trialEndsAt` (new, nullable) is the current subscription's trial
  end, for display; cleared when the plan goes to Free, on a non-active notice
  and on uninstall.
- **Cancel during the trial**: Shopify charges nothing; the webhook moves the
  shop to Free; nothing is deleted. Resubscribing the same week continues the
  same trial (remaining days only).
- **Plans page**: before approval, each paid card says "14-day free trial" and
  "Free until <date>, then $4.99 a month"; the button reads "Start free trial
  of Growth" for a store on Free. During the trial, a banner gives the end date,
  the price after it and that cancelling before then costs nothing; other cards
  say how many days carry over; the cancel dialog says it costs nothing. Dates
  are the store's calendar days in the merchant's regional format.
- **Start date caveat**: the trial is counted from the charge's `createdAt`
  (when it was created, at most the approval delay before Shopify's own start).
  The end the app shows is therefore never later than Shopify's, so "you won't
  be charged before <date>" is always true; a merchant who waited days to
  approve may be billed a little later than shown, never earlier.
- **Dev stores** keep using test charges, with the trial.
- **Tests**: `tests/db-trial.test.ts` (first subscription, activation and the
  ledger, replayed webhook, mid-trial switch with remaining days and
  immediate replacement, no stacking, yearly, cancel during trial, uninstall +
  redact + reinstall, pre-trial subscribers, development store in production),
  `tests/unit/plans-trial-render.test.tsx`, `tests/unit/listing-copy.test.ts`.
- **Copy**: Plans, Help ("Is there a free trial?"), both privacy pages (the
  hashed record that outlives deletion), and the App Store listing.

---

# Previous pass: QA review of 2026-10-25


Scope: every change since `b2bdbed` (131 files, the pass recorded in
`AUDIT.md`), plus a read of the flows it touches: install and provisioning,
survey editor and live preview, the checkout blocks and their endpoints,
answer storage, analytics, CSV export, uninstall / reinstall, GDPR webhooks,
retention, billing.

Baseline before any fix: `npm run check` green (typecheck, extension
typecheck, `check:extensions`, `check:build-deps`, 110 files / 1,451 tests
against real Postgres), `npm run build` clean (only React Router v8
future-flag notices), no `process.env` in the client bundle, no secrets or
debug output in frontend code. There is no linter configured; the type
checkers and `check:extensions` are the static checks.

Severity: **critical** = data loss, wrong money, broken checkout or a
security hole; **major** = a flow a merchant or buyer cannot complete;
**minor** = wrong but recoverable, cosmetic, or documentation.

## Bugs

| Id | Sev | File:line | Root cause | Status |
| --- | --- | --- | --- | --- |
| R1 | major | `app/components/survey-editor.tsx` (`AnswerList`, ~L629-L733) | The editor capped a question at `MAX_OPTIONS` (10) answers **not counting** an "Other (please specify)" option, but the shared validator counts every option, Other included. A template question with Other let the merchant add up to 10 more answers, and "Use answers for a country › Add" filled to 10 too: every save then failed with `options_too_many` while the counter read "10 of 10". Reproduced against `validateSurveyDefinition`. | fixed (247f020) |
| R2 | minor | `extensions/shared/src/use-multi-survey.ts` (country filter, ~L388) | Answers limited to other countries (F4) are hidden before the buyer sees a multiple-choice question, but its "pick at least N" rule was not. With fewer answers left than N, the question could never be completed: a required one blocked Submit for good, an optional one could only be skipped. | fixed (8a0e5ae) |
| R3 | minor | `app/components/survey-editor.tsx` (`PresetLoader`) | "Replace my answers" replaced the merchant's own answer list in one click, with no confirmation, although `AUDIT.md` (F3) documents that replacing asks first. Recoverable only by discarding every unsaved edit. | fixed (8a0fd37) |
| R4 | minor | `app/components/country-select.tsx:52` | Every `CountrySelect` used the same radio-group name `st-country-select`. The editor renders one per choice question (inside "Use answers for a country"), so picking a country in one question's list unticked the radio in another's, and arrow keys moved across lists. | fixed (8a0fd37) |
| R5 | minor | `app/routes/app.results.tsx` (`answerCountries`) | The "Buyers in" filter on **Survey results** listed countries and answer counts from every survey of the shop, while the page shows one survey: a country could be offered with a count the selected survey does not have. | fixed (8a0fd37) |
| R6 | minor | `docs/08-render-setup.md:137` | The Render setup guide told operators to set `SUPPORT_EMAIL=you@yourdomain.com` (deprecated and ignored: the address is the `SUPPORT_EMAIL` constant), and listed `SHOPIFY_API_VERSION` as required (it is optional and pinned). | fixed (61edff4) |
| R7 | minor | `app/routes/app.results.tsx:3`, `app/routes/app.surveys._index.tsx:3`, `app/routes/app.responses.tsx:17`, `app/lib/i18n/resolve.server.ts:96` | Leftovers from the pass: two imports on one line (twice), a helper function declared between import statements, and an orphaned doc comment stacked above an unrelated function. No runtime effect. | fixed (61edff4) |

Disproved while fixing (no change): a suspected too-small 16 KB cap on the
submit body. Surveys have at most 5 questions (`LIMITS.MAX_QUESTIONS`), so
the largest real answer set is about 7.5 KB even written entirely in CJK.

Each fix has a regression test that was confirmed to fail on the old code:
`tests/unit/answer-limit.test.tsx` (R1), `tests/unit/answer-countries-min.test.ts`
(R2), `tests/unit/preset-replace.test.ts` (R3, R4),
`tests/db-analytics-country.test.ts` (R5).

After the fixes: `npm run check` green, 113 files / 1,463 tests; `npm run
build` clean.

## Checked and found sound (no change)

- **Checkout blocks**: design settings applied; scale anchors translated with
  the merchant's own words kept; selected tile marked for screen readers; the
  kept-answer retry (`storage`) never throws, drops stale/refused answers and
  hides the survey once the kept answer lands; editor preview never submits.
- **Endpoints**: the 16 KB submit cap is above the largest real answer set
  (at most 5 questions, 500 characters each, ~7.5 KB fully in CJK);
  shop identity only from the session token; CORS on every
  response including auth refusals; `products=` parsing (empty vs absent);
  rate limits and per-token cap before DB reads; duplicates return 200.
- **Exactly-once storage**: per-order advisory lock across surveys and
  surfaces, legacy table checked, usage claim in the same transaction,
  redacted orders never re-stored.
- **Targeting**: order value with currency precision, first/returning,
  country, language, products, sample, dates in the store's zone, answer cap
  from the live count, rotation.
- **Time zones**: range edges and trend days probed for DST-at-midnight zones
  (Santiago, Havana, Beirut), half-hour and 45-minute offsets, Lord Howe's
  30-minute DST; always one bucket per calendar day, window starts at local
  midnight.
- **Analytics**: per-currency sums and AOV denominators, country filter
  disables the answer rate instead of faking one, previous-period comparison,
  CSV columns appended (positions kept).
- **Migration** `20261025090000_option_countries`: additive, defaults to
  every country; applied cleanly on a database holding older data.
- **Presets**: 23 markets, no duplicate keys or countries, ≤ 9 answers each,
  every generic label translated in all ten template languages.
- **GDPR / uninstall**: redact deletes answers, order cache, checkout loads,
  sync rows and scrubs stored data-request exports; deferred batches drain
  without a merchant visit; uninstall nulls the token, drops sessions and
  queued writes, resets the plan; shop/redact skips a reinstalled shop.
- **AI**: there is no AI feature and no OpenRouter (or other model) call
  anywhere, so nothing depends on an external model being up.
- **Support email**: `sourcetracsupport@gmail.com` (`shared/support.ts`) is
  the only address in the app.
- **Links**: every internal admin link and nav entry points at an existing
  route; SSR render of the editor sections (all three plans), presets, product
  picker, languages (incl. RTL), preview and quick start: no crash, no raw keys.

## Not fixable here

- How Polaris renders the admin and the checkout block on a real store
  (`cdn.shopify.com` is blocked in this container), App Bridge's product
  picker, and Shopify's `storage` lifetime in a real checkout.
- Country names come from `Intl.DisplayNames`; the server's ICU and a
  browser's may name a few countries differently, which React reports as a
  hydration text mismatch in the console. It does not affect what is stored.

## Follow-up: test suite and dead code (2026-10-25)

Asked whether the suite is too large. Measured: about 1 line of test per 2
lines of app code, ~75 s for everything, against real Postgres with no mocks.
Most tests pin a failure that actually shipped or was caught (see `AGENTS.md`,
`BUGS.md`), so the size follows the size of the app. Thinning live coverage
would make the program look simpler without making it simpler.

What was genuinely surplus was dead code that still carried tests, now removed:

- The original single-question survey: its checkout client
  (`SurveyView.tsx`, `use-survey.ts`), both public routes (`/api/survey-config`,
  `/api/responses`, which no block called), the legacy submit, its settings
  validation and the `validation.*` strings in all ten locales.
- Helpers referenced nowhere: `sumByCurrency`, `toUtcDateKey`,
  `requiredScopes`, `classifyPlan`, `countSurveys`, `hasResponseFor`,
  `updateSettings`, `fetchChannelsWithResponseCount`, `surveyWindowBounds`,
  `isTrendWindow`, plus two thin aliases whose tests now call the real functions.
- Tests that existed only for those, and two source-text checks already
  covered by behavioural tests in `extension-bundle.test.ts`. The retry-engine
  tests were ported to the live API instead of dropped.

Old `SurveyResponse` rows stay readable: reconciliation, redaction and
analytics for them are unchanged and still tested.

Result: 110 files / 1,409 tests, `npm run check` green, build clean.
