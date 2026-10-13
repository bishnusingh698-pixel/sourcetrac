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
