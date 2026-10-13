# TEMPLATES_NOTES

Working notes for the Templates, Insight Library and Survey Studio build.
Where this file and `templates-and-studio.md` disagree, the code wins and the
disagreement is recorded here.

## Phase 0 — Languages audit

**APP_LOCALES** (the app's supported languages, `app/lib/i18n/languages.ts`):

| Code | Native name | RTL |
|---|---|---|
| `en` | English | no |
| `de` | Deutsch | no |
| `fr` | Français | no |
| `es` | Español | no |
| `pt-BR` | Português (Brasil) | no |
| `zh-CN` | 简体中文 | no |
| `ja` | 日本語 | no |
| `it` | Italiano | no |
| `nl` | Nederlands | no |
| `sv` | Svenska | no |

US English (`en`) is the default and fallback.

**No RTL language is among the 10.** `ar` and `he` deliberately resolve to
English (see the RTL comment in `languages.ts`). The plan's RTL checks are
therefore recorded as not-applicable, and mirrored-layout testing is skipped.
This is a deliberate, pre-existing decision, not a regression.

**Existing i18n setup.** Every admin string goes through `createTranslator`
(`app/lib/i18n`). Locale files live in `app/lib/i18n/locales/<code>.json`. Two
tests already enforce parity:

- `tests/i18n.test.ts` — every non-English bundle has exactly the keys `en` has,
  with matching `{{placeholders}}` and no left-over English.
- `tests/unit/i18n.test.ts` — the same key set, from the bundled `RESOURCES`.

**Missing-key test across all 10 locales.** Already present and must stay green
for every new admin key this plan adds. In addition, template *content* lives in
`shared/templates/locales/<code>.json` (not in the admin bundle), so it needs its
own parity test: `tests/unit/template-locales.test.ts` asserts that every
template field key defined in `en` exists in all 10 template locale files.

## Plan conflicts / verify items

- **`shared/plans.ts`** does not exist. The plan's plan model is
  `app/lib/plans.ts` (`free` / `growth` / `scale`, with `PLANS`, `planFor`,
  `effectivePlan`). Template plan gating uses `app/lib/plans.ts`. Recorded as a
  file-name conflict; the code wins.
- **Question type name.** `shared/survey-rules.ts` calls the NPS type `nps`, not
  `nps_0_10`. The templates use `nps`.
- **Payment-method targeting (T7).** Now **verified** against shopify.dev and the
  installed `@shopify/ui-extensions` types (2026-07). `shopify.selectedPaymentOptions`
  is on the thank-you target's `StandardApi`, and each option's `type` union is
  `creditCard | deferred | local | manualPayment | offsite | other |
  paymentOnDelivery | redeemable | wallet | customOnsite`. Two findings closed a
  real defect:
  - The old matcher accepted `manualPayment` or a non-existent `manual`; it
    **missed `paymentOnDelivery`**, the exact "payment collected on delivery"
    case the plan names. Both are now matched.
  - The extension **never read the selection and never sent `paymentTypes`**, so
    the server saw an empty list on every order and hid the survey — the rule was
    non-functional, not merely unverified. The thank-you block now binds
    `getPaymentTypes` (reading `shopify.selectedPaymentOptions.value` lazily) and
    `fetchSurvey` sends them. An empty array still means "not matched" (hiding is
    the safe failure), which is stated in Good to know.
- **`selectedPaymentOptions` empty.** Documented developer reports of it coming
  back empty on Thank you for some offsite methods. The rule therefore hides the
  survey when empty rather than showing it, and this is stated in Good to know.
- **S10 preview in checkout editor.** Both halves are **verified supported**, so
  the earlier "does not fit" note was wrong and is corrected here:
  - *Detection:* `shopify.extension.editor` (type `Editor`, `type: 'checkout'`)
    is typed in the installed `@shopify/ui-extensions` and already read by both
    checkout blocks.
  - *Data path:* `shopify.appMetafields` is available on
    `purchase.thank-you.block.render` and declared with
    `[[extensions.targeting.metafields]]` (key + namespace; no `owner_type` in
    the extension config syntax). So a second app-owned metafield holding a
    preview config is feasible, and the compiled config (~11.5 KB) is far under
    the metafield size limit.

  Shipped instead the plan's **step-3 fallback** ("Open checkout editor" link
  under the Studio preview) as a deliberate scope decision, not a limitation:
  the app's config path is HTTP (`getCompiledConfig` → `/api/survey`) and
  shipping the metafield preview would add a parallel metafield read/write path
  plus a Studio action, for an admin-only preview. Recorded in `FUTURE_TASKS.md`
  with the concrete steps to build it. The plan sanctions this outcome ("If not
  supported … Open checkout editor"), so S10 is PARTIAL with a stated reason.
- **`s-box` card border / choice layout attributes.** Both verified against the
  installed `@shopify/polaris-types` rather than guessed. Where an attribute had
  no match, the setting was hidden (see the Design tab).
- **Classic templates.** The 12 templates from the previous `survey-templates.ts`
  are mapped to the new library where they overlap and kept under a "Classic"
  origin label otherwise; existing surveys created from them are independent
  copies and keep working.

## Phase 5 — Survey Studio concurrency (section 6.6)

- **`Survey.revision` is the optimistic token, not `updatedAt`.** Answer counting
  increments `responseCount` through `survey.update`, which moves Prisma's
  `@updatedAt` on every answer. Using `updatedAt` as the conflict token would
  therefore refuse a merchant's save whenever a shopper answered while the editor
  was open — a false conflict on exactly the busiest surveys. `revision` is a
  plain `Int` bumped only by merchant writes (save, publish, pause/activate).
  `tests/db-survey-drafts.test.ts` pins the false-conflict case: incrementing
  `responseCount` must not move the token.
- **The check is skipped when the token is absent.** `updateSurvey` /
  `publishSurveyDraft` take an optional `expectedRevision`; `undefined` means the
  caller is not tracking one (older payloads, direct library calls in tests) and
  no comparison happens. The route reads `revision` from the form and passes it
  through; both the hidden save input and `submitIntent` carry it.
- **A conflict is a warning, not an error page.** The action returns
  `{ ok: false, conflict: true, issues: [] }` and the Studio renders the
  `studio.conflict` banner ("This survey changed in another window. Reload to
  see the latest version."). The message is translated in all 10 locales.

## Phase 6 — Overview, Results and minimal Home

- **Home (T16) vs dashboard.** `/app` is the minimal landing page the plan asks
  for: three cards (status, up to three active surveys with one key number each,
  one next step). The full channel report, trend and range switcher — which
  previously lived on `/app` — moved to `/app/dashboard`, a legacy route kept
  reachable and re-listed in `s-app-nav`. This is a deliberate split, not a
  removal: nothing the dashboard showed was dropped, it changed address.
- **Cross-question key resolution.** `resultsHints.crossQuestion` names template
  question keys (`q_channel`); a stored survey uses the stable id
  `buildSurveyDefinition` derives (`channel_compass_q_channel`). The insights
  builder converts through `stableQuestionId`. Reverting that conversion makes
  the T14 view vanish for every template silently — guarded by
  `tests/unit/insights-build.test.ts`.
- **Home falls back to a template name from the template bundle.** Template names
  are not in the admin i18n bundle, so `app._index.tsx` resolves the seasonal
  spotlight and the "Channel Compass" default server-side via `templateText` and
  passes them as props. A component that called `t()` for these would render a raw
  key.
- **Ideas only for template surveys.** A survey created from scratch shows no
  ideas unless it carries a `templateId` and keeps the template's question keys,
  matching the plan.

## Phase 7 — Smart actions (T13) and S10

### T13 was stored but never applied

The presets were persisted (`buildWizardSyncOptions` wrote the preset ids into
`Survey.syncOptions.presets`) but nothing turned them into Shopify writes. The
one `runSyncKind` implementation substituted `{channel}` only, so a preset tag
named `delivery-check:{optionKey}` would have shipped **literally** as
`delivery-check:optionkey` on every order — the same failure the earlier note
warned about, just moved one layer down.

- **`resolveSmartActionWrites`** (`shared/templates/smart-actions.ts`) is now the
  single resolver: preset ids + the response's stored answers → concrete order
  tags, customer tags, customer metafields. Pure and unit-tested
  (`tests/unit/smart-actions.test.ts`). It maps a value through the preset's
  `valueMap`, guards on `onlyForOptionKeys`, and bands a numeric answer
  (rating/NPS) through `numericBands`.
- **Tags are built from option keys only.** The resolver receives stored option
  *ids*; `optionKeyFor` strips the stable-question-id prefix back to the template
  key. A translated label can never reach a tag, so the tag is identical in every
  language — pinned by a test.
- **`buildWizardSyncOptions` now stores only `{ presets }`.** The literal tag
  names it used to write are gone; the resolver builds them per answer.
- **`requiredKinds` / `hasSyncWork` / `requiredScopes` account for presets.**
  Without this a preset-only survey would enqueue nothing, or the metafield kind
  would try to write with the order scope when the field belongs to the customer.
- **Customer metafields target the customer, not the order.** `MetafieldsSetInput`
  needs `ownerId` = the customer GID; the old code always used the order GID and
  put the *channel label* in the value. A preset metafield now carries the
  **answer** as its value, against the order's customer, and is gated on
  `write_customers`.
- **Pro gate at submit.** T13 is Pro-only, so `submitAnswer` drops `presets` when
  `input.plan !== "scale"`. A shop that downgrades keeps its stored config but
  stops writing. This is the same shape as the scope gate: skip, never throw.

### S10 — the plan's mechanism does not fit this app

The plan says to write a preview config to a **second app-owned metafield** and
have the extension read it only when it detects the editor. Two mismatches:

1. **This app serves config over HTTP, not metafields.** There is no config
   metafield to add a preview sibling to; `getCompiledConfig` builds the payload
   in memory and `/api/survey-config` returns it. Adding a metafield path just for
   preview would be a second source of truth for the same data.
2. **The editor has no order,** and the extension's config fetch is keyed on the
   order id (`useMultiSurvey(orderId, …)`). Inside the editor the blocks render a
   static `MultiSurveyPreview` and fetch nothing, by design — so "render the draft
   in the editor" cannot reuse that path without giving the editor a fake order,
   which the plan itself forbids (submissions in editor mode must never be sent).

Built the fallback instead: an **"Open checkout editor"** link (with its
explanatory note) under the Studio preview caption, opening
`/settings/checkout/editor?page=thank-you` with `target="_top"`. The i18n keys for
both branches already existed in all 10 locales; the fallback branch is now wired.
The editor-detect property the plan asks about (`shopify.extension.editor`) does
exist and is already used by both checkout blocks — detection was never the
blocker.
