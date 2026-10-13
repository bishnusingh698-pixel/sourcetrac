# Changes summary — SourceTrac

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

**🟠 High**
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

**🟡 Medium**
- **Tag sanitisation** (`app/lib/sync.server.ts` `sanitizeTag`). Commas, control
  characters and quotes stripped; 40-char cap; letters of any script kept.
- **Flow/metafield size guards** (`truncateForPayload`,
  `MAX_FLOW_PAYLOAD_BYTES=45_000`). Prevents silently-rejected Flow payloads.
- **CSV row cap** (`app/routes/app.export_.csv.tsx`, `MAX_CSV_ROWS=50_000`).

**🔵 Low**
- **Flow trigger contract test** updated to read the `flowPayload` object after
  the size-guard refactor.

### New tests

- `tests/unit/token-submission-limit.test.ts` — per-token cap.
- `tests/unit/tag-sanitize.test.ts` — tag sanitisation + payload truncation.
- `tests/db-verification-cap.test.ts` — atomic cap + verified/unverified revenue
  (real Postgres).
- `tests/unit/logic-tree.test.ts` — `buildLogicTree` + the no-duplicate-rule
  guard (Phase G).
- `tests/unit/survey-rules.test.ts` — added show-if chain and range-edge cases.

### Verification (2026-10-12)

- `npm run check` — 624 tests across 50 files, all green; typecheck and lint clean.
- `npm run check:extensions` / `typecheck:extensions` — clean.
- `npx shopify app build` — thank-you and order-status blocks 33.5 KB original /
  ~11.5 KB compressed each (budget 64 KB); admin blocks 22.5 KB / ~8.1 KB.

### New / changed database columns

- `prisma/migrations/20261012140000_response_verification/` — additive only:
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
   100) — see `FUTURE_TASKS.md`.

### Accepted risks / documented divergences

- Free caps are 50 responses/mo with global survey/question limits (code wins
  over the brief's 100 / 1 / 2). Recorded, not changed.
- Advanced options are not yet grouped under a collapsed disclosure.
- Product/collection targeting has data plumbing but no picker (deferred).
- Plan reconciliation on a transient Shopify read failure still downgrades
  (billing-policy decision, tracked in `BUG_FIX_REPORT.md`).

## Phase 7 — Smart actions (T13) and S10 (2026-10-13)

### Fixed: T13 presets were stored but never applied

`buildWizardSyncOptions` wrote the smart-action preset ids into
`Survey.syncOptions.presets`, but nothing turned them into Shopify writes. The
only substitution in `runSyncKind` was `{channel}`, so a preset tag like
`delivery-check:{optionKey}` would have shipped **literally** as
`delivery-check:optionkey` on every order.

- `resolveSmartActionWrites` (`shared/templates/smart-actions.ts`) now resolves a
  preset + the stored answers into concrete order tags, customer tags and
  customer metafields. Pure; `tests/unit/smart-actions.test.ts` (13 cases) covers
  the value map, the `onlyForOptionKeys` guard, rating bands and NPS bands.
- Tags are built from option keys only, so the same answer produces the same tag
  in every language.
- `buildWizardSyncOptions` stores only `{ presets }` now.
- `requiredKinds` / `hasSyncWork` / `requiredScopes` account for presets, and a
  preset metafield is gated on `write_customers` (a customer field, not an order
  field).
- A customer metafield's `ownerId` is now the **customer** GID, and its value is
  the **answer** — the old code always wrote to the order with the channel label.
- Pro gate: `submitAnswer` drops `presets` unless the plan is Scale, and
  `loadSyncContext` drops them again against the *current* plan so the lazy
  sweep cannot bypass a downgrade.

### S10 — fallback link, not the plan's metafield mechanism

The plan's mechanism (write a preview config to a second app-owned metafield, read
it only in the editor) does not fit this app: the compiled config is served over
HTTP, so there is no config metafield to add a sibling to; and the checkout editor
has no order id, so the extension's order-keyed config fetch never runs there.
Built the fallback: an **"Open checkout editor"** link and note under the Studio
preview caption, opening `/settings/checkout/editor?page=thank-you` in the top
window. The `shopify.extension.editor` detect property exists and is already used
by both blocks — detection was never the blocker. Recorded in `TEMPLATES_NOTES.md`.

### Verification

- `npm run check` = 827 tests / 59 files green; typecheck, extension typecheck,
  lint and `shopify app build` clean. (The bundle grew slightly in the follow-up
  below: the exclusive-option reconciler added to the shared extension view.)
- Housekeeping: fixed 11 mis-encoded em-dashes (CP1251 byte sequence for the
  em-dash) in this file.

## Phase 8 — Polish, acceptance and docs (2026-10-13)

Closing phase of the Templates, Insight Library and Survey Studio build. No new
features; the work is verification, small clean-ups and the docs the plan asks
for. All automated checks the plan names are green:

- **Locale parity and length limits.** `tests/unit/template-locales.test.ts`
  (84 tests) asserts every template field key in `en` exists in all 10 template
  locale files, that English tag text is <= 32 characters, and that every
  template builds a valid definition for every region **in every locale** — so a
  translation that overflows its field fails the build, not a shopper. Admin
  parity (every key present in `en` appears in all 9 other bundles, with the same
  `{{placeholders}}`) is enforced by `tests/i18n.test.ts`.
- **No browser `process.env`.** A `process.env` scan over
  `build/client/assets/*.js` is empty (the root-loader-only rule holds).
- **Extension bundles under budget.** `npx shopify app build`: checkout blocks
  ~11.5 KB compressed, admin blocks ~8.1 KB, unchanged this phase.
- **No hard-coded colours** in `app/` (themeable tokens only), checked on the
  diff.

Housekeeping fixed in this phase:

- Removed a dead ternary in `tests/unit/template-locales.test.ts`
  (`category === "after_delivery" ? false : false`) left from Phase 1; both legs
  evaluated to `false`, so the full (non-Lite) definition was always the one
  tested, which is what the test intends. The Lite path is covered separately by
  the "builds a valid Lite version for every template" test.
- Repaired three CP1251-mangled severity headings in this file
  (`рџџ  High` / `рџџЎ Medium` / `рџ”µ Low` -> the 🟠 / 🟡 / 🔵 originals).

### Follow-up hardening — read yes/no from its canonical field

While re-auditing the T13 resolver I suspected a bug: three presets sit on a
**yes/no** question (`reorder_customer_tag` / `reorder_window_metafield` gated on
`q_reorder_reminder`, `needs_by_date_order_tag`, `bulk_interest_order_tag`), and
`survey-rules.ts` defines yes/no as *numeric* (`numberValue`, yes = 1 / no = 0),
while the resolver read `answer.optionIds[0]`.

I checked before trusting it, and **the suspicion was wrong**: the checkout
extension mirrors the choice into `optionIds` (`["yes"]`/`["no"]`) *as well as*
`numberValue`, and the route stores both. Confirmed by driving the real submit
path against Postgres — a stored yes/no answer is
`{optionIds:"[\"yes\"]", numberValue:1}` — so the old read returned `"yes"` and
the presets did fire. No production bug.

Kept the change anyway as hardening, not as a fix: the resolver now reads the
**canonical** `numberValue` field through `answerOptionKey` and treats
`optionIds` as the choice-question path only, so it no longer depends on the
extension's redundant mirror — a field a future client or the admin preview need
not send. The unit fixture gained a `yesNo()` helper that pins the numberValue-
only shape, and the both-shapes case is asserted too. See `AGENTS.md` for the
storage detail.

### Follow-up hardening — the exclusive option now clears the others (T6)

T6 was only half-built. The server (`validateResponse`) rejected an answer that
combined an exclusive option ("None of these") with any other
(`exclusive_with_others`), and the editor let a merchant mark an option
exclusive — but **neither the admin preview nor the checkout extension applied
the clearing rule**. A buyer who tapped a normal option and then "None of these"
(wrongly kept both by the `s-choice-list` control) got a 422 back and lost the
whole submission, not just the one answer.

Both surfaces now reconcile the selection the control reports against the
previous one: `reconcileMultiChoiceSelection` / `applyMultiChoiceToggle` in
`shared/survey-rules.ts` for the preview, and a mirrored `applyExclusiveToggle`
in `extensions/shared/src/survey-logic.ts` for checkout (the extension cannot
import the shared module). `tests/unit/survey-rules.test.ts` covers the server
rejection and both helpers; the new `tests/unit/exclusive-option.test.ts` pins
the extension helper to identical behavior so the two copies cannot drift.

**Definition of done.** All 21 templates exist in all 10 languages (After
delivery only when its flag is on); T1–T16 and S1–S13 are implemented or
documented as skipped with a reason (`COMPLIANCE_MATRIX.md`, `TEMPLATES_NOTES.md`
— the one partial is S10, fallback link); tests and build pass; shoppers never
see drafts or previews; and `TRANSLATION_REVIEW.md` lists every added string by
language for a native-speaker pass.

