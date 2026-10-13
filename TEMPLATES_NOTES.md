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
- **Payment-method targeting (T7).** Shopify's checkout UI extension exposes
  `shopify.selectedPaymentOptions` on the Thank you page, but the *type* field
  value for manual/COD payment methods could not be verified against
  shopify.dev from this container (network blocked). Implemented defensively:
  the extension matches an option whose `type` is `manualPayment` and treats an
  empty array as **not matched**. Recorded as unverified; revisit before
  enabling the toggle by default.
- **`selectedPaymentOptions` empty.** Documented developer reports of it coming
  back empty on Thank you for some offsite methods. The rule therefore hides the
  survey when empty rather than showing it, and this is stated in Good to know.
- **S10 preview in checkout editor.** Could not confirm an
  `extension.editor`-style property on the current checkout extension API from
  this container. Built the fallback (`Open checkout editor` link) and left a
  hook in place; recorded as not-built with the reason.
- **`s-box` card border / choice layout attributes.** Both verified against the
  installed `@shopify/polaris-types` rather than guessed. Where an attribute had
  no match, the setting was hidden (see the Design tab).
- **Classic templates.** The 12 templates from the previous `survey-templates.ts`
  are mapped to the new library where they overlap and kept under a "Classic"
  origin label otherwise; existing surveys created from them are independent
  copies and keep working.

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
