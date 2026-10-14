# Deep Loophole Hunt — report (2026-10-14)

Independent loophole hunt over the SourceTrac Shopify app: code read directly,
tests and docs treated as claims to disprove. Scope: response submission, webhooks,
billing/plan gates, admin writes, CSV/search, sync/Flow, extensions.

## Summary

| ID | Severity | Title | Status | Commit | Test |
|---|---|---|---|---|---|
| DH-001 | High | Targeting facts (first/returning, country, responseCount) never sent | Fixed | `77f035f` | extension-bundle + unit |
| DH-002 | High | Template plan lock enforced only in the UI | Fixed | `67ea8ae` | template-plan-enforcement / db-template-plan |
| DH-003 | High | Legacy `/api/responses` missed the per-session-token cap | Fixed | `57857fb` | db-extension-routes |
| DH-004 | High | v2 reconcile never cleared `unverifiedFailed` → revenue lost forever | Fixed | `b16c4b7` | db-verification-cap |
| DH-005 | Medium | Home setup gate ignored the v2 `Response` table | Fixed | `fc784e8` | db-home-gate |
| DH-006 | High | Buyer language never sent → language targeting dead + translations unapplied | Fixed | this commit | extension-bundle |
| D1 | Medium | Dashboard + `/app/export` still read legacy `SurveyResponse` | Deferred | — | — |
| D2 | Low | Build/test-only dependency advisories (tinypool, braces, …) | Deferred | — | — |
| D3 | Low | `productIds` targeting inert (no line-item read) | Deferred | — | — |
| N/A | — | Injection / raw-SQL / SSRF / weak-compare / CORS sweeps | Not a bug | — | — |

## Findings

**DH-006 (High) — buyer language never reached the config fetch.**
`extensions/shared/src/use-multi-survey.ts` called `fetchSurvey(orderId,
placement, null)`, hardcoding `locale = null`. So (a) `targeting.languages` never
matched and a language-targeted survey was hidden from every buyer, and (b) the
merchant's per-language text (`Survey.translations`, shipped in the compiled
config) was never applied — every buyer read the default language. The blocks
already wired `getLocale` into `createSurveyApi`, and the admin preview already
applied translations; only the live checkout path was wrong. Fix: `createSurveyApi`
returns `getLocale`, the hook sends it and overlays the pack via the new
`localizeSurvey`. Answers still store option **ids**, so revenue is unchanged.

**DH-001..DH-005** were found and fixed in the same session and are recorded in
`docs/DEEP_REVIEW_NOTES.md` with the failing-test evidence for each.

## Web research (answers used; each was asked before searching)

1. **Shopify CLI 4.8 extension entry for `api_version >= 2025-10`** — the CLI
   generates `shopify.extend(target, (...args) => Default(...args))`, so the
   default export is called as a function on the remote-dom runtime, not
   `reactExtension(...)`. Confirmed against the installed CLI bundle. → DH
   extension-bundle test entry.
2. **`@shopify/shopify-api` v15 surface** — no `LATEST_API_VERSION`; only
   `unstable_managedPricingSupport` / `customerAddressDefaultFix` flags exist.
   Matches the code; no change needed.
3. **`authenticate.public.checkout` session token claims** — trust only `dest`,
   `aud`, `exp`, `jti`; `dest` is the bare `store.myshopify.com`. Code uses
   `sessionToken.dest` and never a body field. Correct.
4. **`authenticate.webhook` topic casing** — the library upper-cases to
   `ORDERS_CREATE`; the route maps back with `normaliseWebhookTopic`. Correct.
5. **Checkout UI extension `network_access`** — `network_access = true` alone
   permits fetch; `allowed_urls` is not in the schema. TOMLs match.
6. **GDPR mandatory webhooks** — `customers/data_request`, `customers/redact`,
   `shop/redact`, 5-second budget; large redacts must be deferred. Code defers
   past `REDACT_BATCH_SIZE` (200). Correct.
7. **OWASP CSV injection** — cells beginning `= + - @ TAB CR` must be neutralised;
   `escapeCsvValue` prefixes them. Correct.
8. **Prisma + Neon pooling** — migrations need `DIRECT_URL` / non-pooler; the
   migrate script strips `-pooler` and retries while Neon wakes. Correct.

(Full URLs are in `docs/DEEP_REVIEW_NOTES.md`.)

## Not covered

- Live Shopify Admin API / billing against a real or development store (no store
  available; none was touched).
- Render/Neon behaviour under real load (cold start, suspend mid-transaction) —
  reviewed from code and retry logic only.
- `TRANSLATION_REVIEW.md` native-speaker pass (content, not correctness).

## Founder actions

- **Approve the new scopes** (`read_orders,write_orders,write_customers,
  read_products`) and re-install on any test store — the Phase 7 sync paths skip
  safely without them.
- **Decide D1**: whether the dashboard should read v2 (`Response`) or the two
  shapes should be merged. Until then, treat Home / Results / Responses as the
  reports that reflect a live store.
- **Keep the Partner Dashboard `network_access` opt-in** enabled (deploy blocker
  if off).
- No secret rotation and no migration needed for these fixes.
