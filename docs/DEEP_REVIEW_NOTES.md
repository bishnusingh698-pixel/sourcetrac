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


