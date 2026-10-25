# SourceTrac audit and work plan (2026-10-25)

Source of truth for this pass. Items are ticked as they land; each commit names
the item ids it closes.

## How the app works (map)

| Flow | Where |
| --- | --- |
| Install, OAuth, token exchange, expiring offline tokens | `app/shopify.server.ts`, `app/session-storage.server.ts`, `app/lib/token-migration.server.ts`, `app/routes/auth.$.tsx` |
| Shop provisioning on every admin load | `app/lib/provision.server.ts` (`ensureShop`), `app/lib/shop.server.ts` |
| Admin shell, nav, plan strip, banners | `app/routes/app.tsx`, `app/lib/nav.ts`, `app/components/top-nav.tsx` |
| Home / setup guide / dashboard | `app/routes/app._index.tsx`, `app/lib/dashboard.server.ts` |
| Survey list, templates, editor, live preview | `app/routes/app.surveys.*`, `app/components/survey-editor.tsx`, `survey-settings-panels.tsx`, `survey-preview.tsx` |
| Survey storage, drafts, publish, compiled config cache | `app/lib/surveys.server.ts` |
| Shared rules (validation, show-if, scoring, targeting) | `shared/survey-rules.ts`, `shared/survey-config.ts`, `shared/plan-features.ts` |
| Buyer survey (Thank-you, Order status) | `extensions/sourcetrac-thank-you`, `extensions/sourcetrac-order-status`, `extensions/shared/src/*` |
| Config + submit endpoints | `app/routes/api.survey.tsx`, `api.survey-responses.tsx`, `api.survey-preview.tsx` (legacy: `api.survey-config.tsx`, `api.responses.tsx`) |
| Answer storage, cap, learn & stop, sync enqueue | `app/lib/answers.server.ts` |
| Webhooks (orders, uninstall, billing, GDPR) | `app/routes/webhooks.tsx`, `app/lib/webhooks.server.ts`, `app/lib/compliance.server.ts` |
| Analytics | `app/lib/channel-report.server.ts`, `analytics*.ts`, `survey-analytics.server.ts`, `app/routes/app.dashboard.tsx`, `app.results.tsx` |
| Responses + CSV | `app/routes/app.responses.tsx`, `app.export*.tsx`, `app/lib/csv.ts`, `survey-export.server.ts` |
| Billing | `app/lib/billing.server.ts`, `app/routes/app.plans.tsx` |
| Retention | `app/lib/retention.server.ts`, `/jobs/retention` |

Baseline before any change: `npm run check` green (typecheck, extension
typecheck, extension checks, build-deps check, 1,391 tests in 104 files against
real Postgres 18), `npm run build` clean. There is no linter configured; the
typecheckers and `check:extensions` are the static checks.

The previous audit (`BUGS.md`, 83 findings) is fully fixed. This pass looked
for what it did not cover: what the buyer actually sees, merchant settings that
do nothing, editor states the server refuses, and the merchant-facing gaps the
brief asks for.

## Bugs

| Id | Sev | Where | Root cause | Status |
| --- | --- | --- | --- | --- |
| B1 | major | `extensions/shared/src/MultiSurveyView.tsx`, `ThankYouBlock.tsx`, `OrderStatusBlock.tsx` | The editor's look settings (show title, star rating style, progress, scale labels, border, spacing) are stored and compiled into `survey.design`, but the block never reads `design`. A merchant who turns "Show title" off or picks stars still gets the default look. | [x] |
| B2 | major | `MultiSurveyView.tsx` (NPS / rating) | 0–10 and 1–5 scales render bare numbers with no "not likely / very likely" anchors, so buyers guess which end is good; the scale labels the merchant can set are never shown. Default labels are English and would reach every buyer untranslated. | [x] |
| B3 | minor | `MultiSurveyView.tsx` (text questions) | The question is drawn twice: once as the bold question line and again as the text field's visible label. | [x] |
| B4 | minor | `MultiSurveyView.tsx` (single choice tiles) | The chosen tile is only a slightly darker background; nothing says it is selected, for sighted buyers or screen readers. | [x] |
| B5 | major | `app/components/survey-editor.tsx` | The editor can build states the server always refuses: removing an answer that a follow-up depends on, changing the parent question's type, or moving a follow-up above its parent. Save then fails with `show_if_option_unknown` / `show_if_unknown` and the merchant has to find the cause. | [x] |
| B6 | major | `app/lib/analytics.ts`, `dashboard.server.ts`, `channel-report.server.ts`, `app.results.tsx` | Date ranges and the daily trend are cut at UTC midnight. A store in California sees yesterday-evening orders as "today", and "last 7 days" starts at 16:00 local. The brief requires the store's time zone. (Billing periods stay UTC: they are a counter, not a report.) | [x] |
| B7 | minor | `app/lib/i18n/index.ts` (`intlLocaleFor`) | Dates and numbers follow the *language*, not the merchant's region: an English-speaking UK or Australian merchant gets US month/day order; a Swiss German merchant gets German separators. Shopify tells us the admin locale (`en-GB`, `de-CH`) and it is stored but unused for formatting. | [x] |
| B8 | minor | `app/routes/app.responses.tsx` | Order totals are printed raw (`42.50 USD`) instead of locale-formatted money, unlike every other page. | [x] |
| B9 | minor | `app/lib/csv.ts` | Exports omit the buyer's country, language and first-order flag, all of which are stored, so a merchant cannot analyse by them in a spreadsheet. | [x] |
| B10 | minor | `extensions/*/locales` | Only 10 buyer languages. An Arabic, Hebrew, Korean, Polish, Turkish, Danish, Finnish or Norwegian checkout shows the block's buttons ("Submit", "Other", "Thanks") in English. | [x] |
| B11 | minor | `app/components/survey-settings-panels.tsx` (`Languages`) | Survey wording can only be translated into the 10 *admin* languages, so a merchant selling to Arabic- or Hebrew-speaking buyers cannot translate their survey at all. | [x] |
| B13 | major | `extensions/shared/src/use-multi-survey.ts` | When the backend stayed unreachable for the whole 60 s retry budget, the buyer's answer was dropped (`survey_submit_lost`), against the "never lose the answer" rule. It is now kept in the extension's `storage` (Shopify keeps it for the checkout session) and sent first the next time the block loads for that order; an answer the server refused outright is not kept. | [x] |
| B12 | minor | `app/components/survey-editor.tsx` (`FrameText`) | The look section offered only three of the eight stored design settings; the rest were unreachable. | [x] |

Checked and found sound (no change): duplicate submission handling (unique
index + advisory lock, 200 `duplicate`), webhook idempotency, GDPR handlers and
deferred redaction, uninstall/reinstall guards, token refresh, CORS on every
extension response, per-shop isolation (shop identity only from the token's
`dest`), money precision (three-decimal currencies), currency-separated sums,
the free-cap lock, extension retry budget (8 attempts / 60 s), translation
fallback in the block (`localizeSurvey` falls back field by field), the
support address (only `sourcetracsupport@gmail.com` exists in the code).

## UX problems

| Id | Area | Problem | Status |
| --- | --- | --- | --- |
| U1 | Admin nav | Ten menu tiles (Dashboard, Surveys, Templates, Results, Channel report, Responses, Export, Plans, Settings, Help). Results vs Channel report vs Dashboard is the confusion merchants reported. | [x] Seven sections: Home, Surveys, Analytics, Responses, Plans, Settings, Help. Analytics has two tabs (Channels, Survey results); Surveys has two (My surveys, Templates); Responses has two (Answers, Export). Old URLs keep working. |
| U2 | First run | Getting live takes: pick a template among 50, read the editor, find "Go live". | [x] One-screen quick start: country, answers preloaded for that market, Go live. |
| U3 | Editor | "How did you hear about us?" answers are the same three US-centric lists everywhere. | [x] Country-aware presets with a searchable country list, loadable into any choice question. |
| U4 | Editor | Settings without a sentence on what the buyer will see (layout, title, button, thank-you text, required, answer type). | [x] Helper text on each. |
| U5 | Editor | Look settings hidden under "Wording" with no explanation of why colours cannot be chosen. | [x] "Look and wording" section, with the reason colours and fonts follow the checkout's own branding. |
| U6 | Analytics | No country filter; no way to compare markets. | [x] Country filter on both Analytics tabs. |
| U7 | Buyer | Scale questions without anchors; selected answer not marked (B2, B4). | [x] |

## Features

| Id | Feature | Notes | Status |
| --- | --- | --- | --- |
| F1 | Quick start wizard | `/app/surveys/quick-start`: one screen, under two minutes, creates a live "How did you hear about us?" survey from the market preset (or a draft when the plan's live limit is used), then opens the checkout editor step. Linked from Home's setup guide, the Surveys list and the template library. | [x] |
| F2 | Country-aware answer presets | `shared/templates/channel-presets.ts`: US, Canada, UK and Ireland, Western Europe, Nordics, DACH, France/Benelux, Southern Europe, Eastern Europe, Japan, South Korea, China, Taiwan/Hong Kong, Southeast Asia, India, Middle East, Israel, Turkey, Latin America, Brazil, Australia/NZ, Africa, global fallback. Brand names stay as written; generic answers carry translations in every template language. | [x] |
| F3 | Searchable country selector for presets | In the editor's answer list ("Load answers for a country") and in the quick start. Replacing answers on a question with answers asks first, and never on a question whose answers are already in results (it appends instead). | [x] |
| F4 | Answers shown only in some countries | Per-answer "Only show in" list (Growth, like other country rules). Compiled into the config; the block hides those answers for buyers elsewhere. Additive migration `Option.countries`. "Add answers for another country" appends a market's own answers limited to that country. | [x] |
| F5 | Product targeting | "Only orders with these products", picked with Shopify's product picker (App Bridge `resourcePicker`), stored as product ids, evaluated on the server from the order lines both blocks now send. Growth. Replaces the earlier decision to drop product rules (L7 in DECISIONS.md), which was right only while nothing evaluated them. | [x] |
| F6 | Analytics country filter | Both Analytics tabs filter by the buyer's country (stored on every v2 answer). | [x] |
| F7 | Analytics in the store's time zone | B6. Range edges and trend days are the store's calendar days. | [x] |
| F8 | Look settings that work | B1/B12: show title, progress, star or number rating, scale labels, border, spacing, button and thank-you text, all applied in checkout and in the admin preview. | [x] |
| F9 | More buyer languages, RTL | B10/B11: checkout UI strings in Arabic, Hebrew, Korean, Polish, Turkish, Danish, Finnish and Norwegian (Shopify renders right-to-left checkouts itself; our block uses logical layout only). Survey wording translatable into those too. | [x] |
| F10 | Easier new admin languages | `scripts/i18n-merge.mjs` merges a key file into every locale; the language list documents the three steps. | [x] |
| F11 | Export columns | B9: `country`, `buyer_language`, `first_order` appended (existing columns keep their positions). | [x] |

Existing features verified rather than rebuilt: multiple question types
(single, multiple, dropdown, yes/no, rating, satisfaction, NPS, text),
conditional follow-ups, first-time / returning / country / language / order
value / date / sample targeting, randomised answers with Other last, live
preview that follows every edit, CSV export, revenue by channel, trends,
first-time vs returning, NPS and CSAT.

Not added: an AI feature. Nothing in the brief needs one, and a free model
behind a rate limit would be the one part of the app that can be slow or down.

## Removed or reworked

- The ten-tile menu (U1). Dashboard → Home, Channel report + Results → Analytics, Templates under Surveys, Export under Responses.
- "Wording" section renamed and expanded into "Look and wording" (U5).
- The DECISIONS.md L7 rule that dropped product rules on save is replaced by real product targeting (F5). Collection rules stay dropped: resolving a collection's products needs a call per save and a refresh when the collection changes, which a free-tier app cannot keep fresh.

## Database migrations (all additive)

1. `20261025090000_option_countries`: `Option.countries TEXT NOT NULL DEFAULT '[]'`. Existing rows read as "every country", which is today's behaviour.

## Order of work

1. B1–B4, B3 (buyer survey) and F8 (look settings) — what buyers see.
2. B5 (editor follow-up repair).
3. B6/F7 (time zone), B7 (regional formats), B8, B9/F11.
4. F2/F3 (presets), F1 (quick start).
5. F4 (per-country answers, migration), F5 (product targeting).
6. F6 (country filter).
7. U1 (navigation), U4/U5 (helper text).
8. B10/B11/F9 (languages), F10.
9. Verification: full check, build, re-read of every changed file, tricky cases.

## Verification log

See the end of this file once the work is done.
