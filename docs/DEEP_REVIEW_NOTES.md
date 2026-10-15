# Deep Loophole Hunt — running notes

Guide `docs/UNDERSTAND_THE_LOGIC.md` **does not exist** in this repo (closest:
`LOGIC_MAP.md`, `AUDIT_AND_PLAN.md`). Recorded as a doc mismatch. Working from code + LOGIC_MAP.

## Phase 1 — entry points (confirmed from code)
Extension token routes (authenticate.public.checkout):
- GET/POST `api.survey.tsx`, `api.survey-config.tsx`, `api.responses.tsx`, `api.survey-responses.tsx`
Admin (authenticate.admin, guarded): app.tsx, app._index, app.dashboard, app.results, app.responses,
 app.settings, app.plans, app.export, app.export_.csv, app.results_.csv, app.surveys._index,
 app.surveys.$id, app.surveys.library._index, app.surveys.library.$id, app.surveys.library.$id.setup,
 app.help, app.language
Webhooks: webhooks.tsx (authenticate.webhook). Jobs: jobs.retention.ts. Health: healthz, readyz.
Admin-extension ID token: api.admin-survey-context.tsx (loader+action).
No App Proxy routes found.

## Phase 2 — sweep results
- npm audit --omit=dev: 16 vulns (2 critical: tinypool RCE via prototype pollution GHSA-5gmw-xhrv-c9v3,
  GHSA-85c8-ppgw-ccpr; 9 high: @shopify/cli->global-agent->roarr->sprintf-js). tinypool+cli are
  BUILD-TIME only (vitest / shopify app build), not in runtime bundle. Reachable? Only if attacker
  controls test worker options. Likely Low/Not reachable.
- Injection/exec/raw-SQL greps: no hits in app/shared/extensions.
- Open redirect: auth.$.tsx uses safeInternalPath(target) - need to verify.

## Phase 2b — confirmed targeting gaps (code-verified)
- **maxResponses INERT.** api.survey.tsx passes `responseCount: 0`; CompiledSurvey carries
  no responseCount. "Pause after N responses" never triggers.
- **customerType INERT.** api.survey.tsx passes `isFirstOrder: null`; extension never sends it.
  matchesTargeting (shared/survey-config.ts:189) treats null as no-match, so BOTH
  `first_order` and `returning` hide the survey. 7 templates default audience:"first_order"
  (shared/templates/index.ts:134,220,254,595,643,677,803) => launching them shows nothing.
  orderConfirmation.isFirstOrder IS available on the thank-you surface.
- **countries INERT.** api.survey.tsx passes `country: null`. localization.country.isoCode
  available on BOTH surfaces. Country-targeted surveys never show.
- **productIds INERT.** matchesTargeting never reads targeting.productIds; templates with
  productsOnly:true (index.ts:483,763) show to everyone. Deferred (needs line-item read).
- LOGIC_MAP.md:52 claims first/returning + country are evaluated inside matchesTargeting - true
  of the function, but the route never supplies the facts. Doc/code mismatch.

## DH-002 — Template plan enforcement (2026-10-13)

- Loophole: library only hides the "Use template" button; createSurvey had no
  server-side plan gate. A Free shop could POST the setup intent with lite:false
  (or a by-product template) and get the full Growth survey.
- Gate added: assertPlanAllowsSurvey (create) + assertPlanAllowsEdit
  (update/publish), app/lib/surveys.server.ts. Content-based: blocks a definition
  that has an exclusive option (T6) or a resultsHints.byProduct template (T8).
  effectivePlan used, so a cancelled/frozen Growth shop reads as Free.
- Grandfathering: edit/publish allow an existing exclusive option, block ADDING
  one; otherwise a downgrade makes an existing survey unsaveable.
- Setup route hardened: forces lite on a locked plan (loader + action), so a
  direct URL or crafted config cannot build the full template.
- Library display aligned: the three library routes now use
  catalogPlanFromKey(effectivePlan(shop)), not raw shop.plan.
- hasLite corrected: a by-product template has NO Free version (Lite cannot strip
  the results feature); the detail page hides the Lite button and says so.
- Tests: tests/unit/template-plan-enforcement.test.ts (6) +
  tests/db-template-plan.test.ts (6, fails on gate revert).
- Deferred: a downgrade that makes a survey unsaveable without edits is only
  grandfathered, not re-gated; by-product results view gating needs a DB flag.

## DH-003 — Legacy submit route missing the per-token cap (2026-10-14)

- Loophole: `/api/survey-responses` calls `consumeTokenSubmission` (max 2 per
  session token), but the legacy `/api/responses` did not. A valid checkout
  token + a fresh made-up order id per request got a fresh per-order bucket, so
  a script could write unlimited forged answers on the legacy route.
- Fix: added the same `consumeTokenSubmission` call in
  app/routes/api.responses.tsx, before the per-order bucket.
- Test: tests/db-extension-routes.test.ts "caps submissions per session token"
  (fails 200,200,200 without the call; passes 200,200,429 with it).

## DH-004 — v2 reconcile never cleared `unverifiedFailed` (2026-10-14)

- Loophole: `markUnverifiedFailedResponses` (24h sweep) sets `unverifiedFailed=true`
  for a v2 Response with a null total. `reconcileOrderForResponses` filled the
  total and `verified` on a late order but never reset `unverifiedFailed`, so
  `decideSurveyRevenue` excluded the row forever. A late webhook or the dashboard
  backfill could never recover the revenue.
- Legacy path already cleared its flag (`reconcileFromOrderCache` sets
  `unreconcilable: false`); v2 was the regression.
- Fix: reconcile now writes `unverifiedFailed: false` in the same UPDATE
  (app/lib/answers.server.ts). Reverting it fails the new test.
- Test: tests/db-verification-cap.test.ts "recovers revenue when an order arrives
  after the response was written off".

## DH-005 — Home "has any answer" gate ignored the v2 table (2026-10-14)

- Loophole: `app._index.tsx` gated the setup guide on `SurveyResponse` only. The
  multi-question extension writes `Response`; it never writes `SurveyResponse`.
  A merchant whose answers are all v2 saw the setup guide forever, and Home's
  survey cards never rendered.
- Fix: extracted `hasAnyResponse(shopId)` in app/lib/home.server.ts, reading both
  tables; the route uses it for the setup-guide gate.
- Test: tests/db-home-gate.test.ts (2; the v2-only case fails on revert).

## DH-006 — Buyer language never reached the config fetch; translations never applied (2026-10-14)

- Loophole: `useMultiSurvey` called `fetchSurvey(orderId, placement, null)` with a
  hardcoded `locale = null`, so (a) `targeting.languages` never matched — a
  language-targeted survey was hidden from every buyer — and (b) the merchant's
  per-language text (`Survey.translations`, shipped in the compiled config) was
  never applied. Every buyer read the survey in the merchant's default language.
  The checkout blocks already wired `getLocale` into `createSurveyApi`, and the
  admin preview (`survey-preview.tsx`) already applied translations, so only the
  live checkout path was wrong.
- Fix: `createSurveyApi` now returns `getLocale`; `useMultiSurvey` reads it, sends
  it on the config request, and overlays the matching pack via the new
  `localizeSurvey` (option labels from `option.translations[locale]`, falling back
  to the default text). Options still render by key, so revenue is unaffected.
- Test: tests/integration/extension-bundle.test.ts "sends the buyer's language and
  renders the translated survey" (fails when `localizeSurvey` is reverted).

## Deferred / not-a-bug (recorded, not fixed)

- **D1 — dashboard + /app/export still read the legacy `SurveyResponse` table.**
  The live extension writes only `Response`, so `/app/dashboard` and the legacy
  CSV show zero for a real store. Not a regression this hunt introduced (the v2
  migration is additive and these pages predate it), and the working reports are
  Home, Results, Responses and the Results CSV, all on v2. Merging the two shapes
  on the dashboard is a redesign, not a small safe change — deferred with a plan.
- **D2 — dependency advisories.** tinypool (critical) is reached only by vitest;
  braces/deepmerge-ts/@vitest/mocker/sprintf-js are build- or test-time. None is
  in the runtime bundle (`npm run build` output contains none of them). Fixes are
  major downgrades/bumps of build tooling — deferred, documented in AGENTS.md.
- **D3 — productIds targeting** carries no line-item read, so `productsOnly`
  templates show to everyone. Needs `read_products`; already in FUTURE_TASKS.



