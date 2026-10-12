# Future tasks

Deferred work with enough context to pick up cold. Nothing here blocks the
current release.

## Compiled-config delivery via a shop metafield (Phase 4)

The checkout extension reads its survey config from `GET /api/survey` today,
backed by an in-memory per-shop cache (`app/lib/surveys.server.ts`). That path
needs no Partner Dashboard change and works on the free tier, so it shipped.

The plan preferred an **app-owned shop metafield**: the survey is compiled on
save, stored as a metafield the checkout extension reads directly, and the
extension never calls the backend for config. That removes a network round-trip
on the thank-you page.

**Why it is deferred, not forgotten:** the metafield declaration syntax changed
on 2026-10-08 (`owner_type`), and this container cannot reach shopify.dev to
verify the current shape. Shipping an unverifiable declaration risks a deploy
blocker. When the syntax can be confirmed:

1. Declare the metafield in `shopify.app.toml` (or the extension's capabilities).
2. Write it in `surveys.server.ts` wherever `invalidateConfig` runs, alongside
   the cache invalidation.
3. Have the extension read it and fall back to `GET /api/survey` when absent, so
   a store mid-deploy keeps working.
4. Extend `tests/integration/extension-bundle.test.ts` with the metafield path.

## Product / collection targeting UI (Phase 7)

`Targeting` in `shared/survey-config.ts` carries `productIds`, `collectionIds`
and `resolvedProductIds`, and `shopify.app.toml` requests `read_products`, but
the survey editor only shows a note (`surveys.target_products_note`). There is
no picker and no collection-to-product resolution call yet. Add the picker and
the resolver, gated on the granted `read_products` scope via `canSync`.

## Bonus features (B1, B2)

The theme app extension (B1) and the App Proxy survey-link page (B2) are behind
`shared/feature-flags.ts`, both **off**. Turn them on only once Core is stable.

## Free plan caps — reconcile with product intent (audit F-010)

The code enforces a Free response cap of `FREE_RESPONSE_CAP = 50` and applies
global limits (`MAX_ACTIVE_SURVEYS = 10`, `MAX_QUESTIONS = 5`) to every plan; the
audit brief described Free as 100 responses/month, 1 active survey, 2 questions.
The audit left the code as-is (code wins; the constant is interpolated into help
and the plans page). If the product wants the brief's numbers, raise the constant
and add per-plan survey/question gating in `createSurvey` / `updateSurvey`.

## Advanced options disclosure (audit F-011) — DONE

Sample %, dates, response limit, countries and languages now sit under a
collapsed `AdvancedDisclosure` in the survey editor's "Who sees it" section.
Multi-choice min/max selections remain inline (they only appear for that one
question type). Nothing further to do here.

## Logic map "Try a path" simulator polish (Phase G)

The simulator and tree ship now. A follow-up polish pass could persist the last
simulated path and animate node transitions, but the current static highlight is
sufficient and has no correctness impact.

## Plan reconciliation on a transient Shopify read failure

`app/routes/app.plans.tsx` maps `paidPlanFromSubscriptions(...) ?? "free"` into
`setPlan(..., { planStatus: "active" })`. A transient Shopify read failure
therefore downgrades a paying merchant, and a cancelled merchant gets
`planStatus` forced back to `active`. Left as-is on purpose: whether a read
failure should downgrade a paying merchant is a billing-policy decision, not a
mechanical fix. Tracked in `BUG_FIX_REPORT.md`.
