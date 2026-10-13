# Changes summary вЂ” SourceTrac

## Phase 6 — Overview, Results and minimal Home (2026-10-13)

T16 (minimal Home), the survey-scoped Results tab (T8 by product, T14
cross-question, T12 ideas) and the confidence meter (T9) everywhere those read.

### What changed

- **Home (`app/routes/app._index.tsx`) is now the minimal landing page (T16):**
  three cards only — status, up to three active surveys with one key number and a
  confidence label each, and exactly one rule-based next step (unpublished changes
  → reliable results → seasonal spotlight → start from a template). The full
  channel report moved to **`app/routes/app.dashboard.tsx`** (legacy route),
  linked from the status card and re-listed in `s-app-nav`.
- **`app/lib/home.server.ts`** loads the Home rows: it reads at most three active
  surveys, reuses `fetchSurveyResponses` + `buildSurveyInsights`, and computes one
  key number per survey. Nothing is read for a shop with no answers — the setup
  guide still owns that case.
- **`app/lib/insights.server.ts`** joins a stored survey to the pure aggregation
  in `shared/templates/stats.ts`. Surveys created from a template get their T12
  ideas (text interpolated, never a raw `{placeholder}`), the T8 by-product table
  and the T14 cross-question view.
- **`app/components/insights.tsx`** renders the confidence badge, the ideas
  cards, the by-product table and the cross-tab with Polaris web components.
- **Studio (`app/routes/app.surveys.$id.tsx`)** wires `insights` into the
  Overview and Results tabs from one loader computation.

### Bug fixed while wiring the cross-question view

`resultsHints.crossQuestion` names **template question keys** (`q_channel`), but a
stored survey uses the **stable question id** `buildSurveyDefinition` derives
(`channel_compass_q_channel`). The first wiring looked up the raw key, so the T14
view could never appear for any template. It now resolves through
`stableQuestionId(templateId, key)`. `tests/unit/insights-build.test.ts` fails if
the resolution is reverted.

### New tests

- `tests/unit/insights-build.test.ts` — cross-question key resolution (both
  enough-answers and too-few cases), idea interpolation, no-ideas for a
  non-template survey, and the by-product guard.

### Verification (2026-10-13)

- `npm run check` — **794 tests across 57 files**, all green; typecheck,
  extension typecheck, extension config check and build-deps check clean.
- `npm run build` clean; **no `process.env.*` survives into `build/client`**.
- Extension bundles unchanged (no extension code touched this phase).

`TRANSLATION_REVIEW.md` was generated (`scripts/gen-translation-review.py`)
listing all 405 template-content keys and 279 new admin keys across the 10
languages for a native-speaker pass.

### Manual checklist for the founder

Run these by hand against a development store before release.

1. **Home:** shows only the three cards.
2. **Template library:** search "gift"; filter "1–2 questions"; open Gift Radar
   and switch the occasion pack between US, Global and UK & Europe — the preview
   updates.
3. **Admin language:** switch the admin to another of the 10 languages; library,
   tags, templates and Studio are fully translated with no missing keys.
4. **Quick setup:** use Channel Compass, turn off the creator follow-up, go live,
   place test orders, and check the confidence meter appears.
5. **Free plan:** opening Price Pulse offers the Lite version; the full version
   shows "Available on Growth".
6. **Studio before going live:** create a survey from scratch; switch the preview
   between Thank you and Order status and between desktop and mobile; change the
   preview language; answer it to test a show-if rule; click a question in the
   preview and confirm it opens in the editor.
7. **Ready check:** Go live with no placement selected is blocked, and the check
   explains why.
8. **Drafts:** edit a live survey — it shows "Unpublished changes" and a test
   order still shows the old version; publish — the summary lists the changes, a
   test order shows the new version, and old answers remain in Results; discard a
   draft — the live survey is unchanged.
9. **Design:** set Stars, scale labels and one-at-a-time mode; check both the
   preview and a real test order.
10. **Rotation:** two surveys in rotation both get responses, and the same order
    sees the same survey on both pages.
11. **Delivery Ready Check** with "Only orders paid on delivery" on a dev store
    with a manual payment method: shows for manual-payment orders, not for card
    orders, and tags appear when smart actions are on (Pro test plan).
12. **Ad Recall:** "None of these" clears the other choices.
13. **S10:** if built, the draft shows in the checkout editor and never on a real
    checkout. (Currently the fallback link.)
14. **Layout:** every page at 375 px has no horizontal scrolling.

## Audit pass (2026-10-12)

Logic, security and completeness audit. Governing rule: where the referenced
upgrade plan and the code disagree, **the code wins**; every divergence is
recorded in `COMPLIANCE_MATRIX.md` and `AUDIT_REPORT.md`.

### Fixed, grouped by severity

**рџџ  High**
- **Per-token submission cap** (`app/lib/rate-limit.server.ts`
  `consumeTokenSubmission`; `app/routes/api.survey-responses.tsx`). One checkout
  session token may submit at most `MAX_SUBMISSIONS_PER_TOKEN` (2) responses,
  keyed on `jti`, checked before any DB read. Closes forged-order flooding.
- **Atomic free-cap enforcement** (`app/lib/answers.server.ts` `claimUsageSlot`).
  Conditional increment so simultaneous submissions cannot exceed the cap.
- **Order verification before revenue** (new `Response.verified` /
  `unverifiedFailed`; `app/lib/webhooks.server.ts`, `app/lib/survey-analytics.
  server.ts`). Revenue counts verified orders only; unverified-failed answers
  leave the totals; pending is never faked as `$0.00`.

**рџџЎ Medium**
- **Tag sanitisation** (`app/lib/sync.server.ts` `sanitizeTag`). Commas, control
  characters and quotes stripped; 40-char cap; letters of any script kept.
- **Flow/metafield size guards** (`truncateForPayload`,
  `MAX_FLOW_PAYLOAD_BYTES=45_000`). Prevents silently-rejected Flow payloads.
- **CSV row cap** (`app/routes/app.export_.csv.tsx`, `MAX_CSV_ROWS=50_000`).

**рџ”µ Low**
- **Flow trigger contract test** updated to read the `flowPayload` object after
  the size-guard refactor.

### New tests

- `tests/unit/token-submission-limit.test.ts` вЂ” per-token cap.
- `tests/unit/tag-sanitize.test.ts` вЂ” tag sanitisation + payload truncation.
- `tests/db-verification-cap.test.ts` вЂ” atomic cap + verified/unverified revenue
  (real Postgres).
- `tests/unit/logic-tree.test.ts` вЂ” `buildLogicTree` + the no-duplicate-rule
  guard (Phase G).
- `tests/unit/survey-rules.test.ts` вЂ” added show-if chain and range-edge cases.

### Verification (2026-10-12)

- `npm run check` вЂ” 624 tests across 50 files, all green; typecheck and lint clean.
- `npm run check:extensions` / `typecheck:extensions` вЂ” clean.
- `npx shopify app build` вЂ” thank-you and order-status blocks 33.5 KB original /
  ~11.5 KB compressed each (budget 64 KB); admin blocks 22.5 KB / ~8.1 KB.

### New / changed database columns

- `prisma/migrations/20261012140000_response_verification/` вЂ” additive only:
  - `Response.verified  BOOLEAN NULL`
  - `Response.unverifiedFailed BOOLEAN NOT NULL DEFAULT false`

  Existing rows read `verified = NULL` ("before verification existed"); the
  revenue report groups them with the unverified set rather than counting them.

  Apply with the normal deploy: `npm run start` runs `scripts/migrate.mjs`
  against `DIRECT_URL`/`DATABASE_URL`.

### What the founder must do

1. Re-deploy on Render (`npm run start`) so the migration applies.
2. No Partner Dashboard changes are required by this audit.
3. Optional: decide the Free response cap (code currently 50; the brief said
   100) вЂ” see `FUTURE_TASKS.md`.

### Accepted risks / documented divergences

- Free caps are 50 responses/mo with global survey/question limits (code wins
  over the brief's 100 / 1 / 2). Recorded, not changed.
- Advanced options are not yet grouped under a collapsed disclosure.
- Product/collection targeting has data plumbing but no picker (deferred).
- Plan reconciliation on a transient Shopify read failure still downgrades
  (billing-policy decision, tracked in `BUG_FIX_REPORT.md`).
