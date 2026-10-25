# QA review of the 2026-10-25 pass (REVIEW.md)

Scope: every change since `b2bdbed` (131 files, the pass recorded in
`AUDIT.md`), plus a read of the flows it touches: install and provisioning,
survey editor and live preview, the checkout blocks and their endpoints,
answer storage, analytics, CSV export, uninstall / reinstall, GDPR webhooks,
retention, billing.

Baseline before any fix: `npm run check` green (typecheck, extension
typecheck, `check:extensions`, `check:build-deps`, 110 files / 1,451 tests
against real Postgres), `npm run build` clean (only React Router v8
future-flag notices), no `process.env` in the client bundle, no secrets or
debug output in frontend code. There is no linter configured; the type
checkers and `check:extensions` are the static checks.

Severity: **critical** = data loss, wrong money, broken checkout or a
security hole; **major** = a flow a merchant or buyer cannot complete;
**minor** = wrong but recoverable, cosmetic, or documentation.

## Bugs

| Id | Sev | File:line | Root cause | Status |
| --- | --- | --- | --- | --- |
| R1 | major | `app/components/survey-editor.tsx` (`AnswerList`, ~L629-L733) | The editor capped a question at `MAX_OPTIONS` (10) answers **not counting** an "Other (please specify)" option, but the shared validator counts every option, Other included. A template question with Other let the merchant add up to 10 more answers, and "Use answers for a country › Add" filled to 10 too: every save then failed with `options_too_many` while the counter read "10 of 10". Reproduced against `validateSurveyDefinition`. | fixed (247f020) |
| R2 | minor | `extensions/shared/src/use-multi-survey.ts` (country filter, ~L388) | Answers limited to other countries (F4) are hidden before the buyer sees a multiple-choice question, but its "pick at least N" rule was not. With fewer answers left than N, the question could never be completed: a required one blocked Submit for good, an optional one could only be skipped. | fixed (8a0e5ae) |
| R3 | minor | `app/components/survey-editor.tsx` (`PresetLoader`) | "Replace my answers" replaced the merchant's own answer list in one click, with no confirmation, although `AUDIT.md` (F3) documents that replacing asks first. Recoverable only by discarding every unsaved edit. | fixed (8a0fd37) |
| R4 | minor | `app/components/country-select.tsx:52` | Every `CountrySelect` used the same radio-group name `st-country-select`. The editor renders one per choice question (inside "Use answers for a country"), so picking a country in one question's list unticked the radio in another's, and arrow keys moved across lists. | fixed (8a0fd37) |
| R5 | minor | `app/routes/app.results.tsx` (`answerCountries`) | The "Buyers in" filter on **Survey results** listed countries and answer counts from every survey of the shop, while the page shows one survey: a country could be offered with a count the selected survey does not have. | fixed (8a0fd37) |
| R6 | minor | `docs/08-render-setup.md:137` | The Render setup guide told operators to set `SUPPORT_EMAIL=you@yourdomain.com` (deprecated and ignored: the address is the `SUPPORT_EMAIL` constant), and listed `SHOPIFY_API_VERSION` as required (it is optional and pinned). | fixed (61edff4) |
| R7 | minor | `app/routes/app.results.tsx:3`, `app/routes/app.surveys._index.tsx:3`, `app/routes/app.responses.tsx:17`, `app/lib/i18n/resolve.server.ts:96` | Leftovers from the pass: two imports on one line (twice), a helper function declared between import statements, and an orphaned doc comment stacked above an unrelated function. No runtime effect. | fixed (61edff4) |

Disproved while fixing (no change): a suspected too-small 16 KB cap on the
submit body. Surveys have at most 5 questions (`LIMITS.MAX_QUESTIONS`), so
the largest real answer set is about 7.5 KB even written entirely in CJK.

Each fix has a regression test that was confirmed to fail on the old code:
`tests/unit/answer-limit.test.tsx` (R1), `tests/unit/answer-countries-min.test.ts`
(R2), `tests/unit/preset-replace.test.ts` (R3, R4),
`tests/db-analytics-country.test.ts` (R5).

After the fixes: `npm run check` green, 113 files / 1,463 tests; `npm run
build` clean.

## Checked and found sound (no change)

- **Checkout blocks**: design settings applied; scale anchors translated with
  the merchant's own words kept; selected tile marked for screen readers; the
  kept-answer retry (`storage`) never throws, drops stale/refused answers and
  hides the survey once the kept answer lands; editor preview never submits.
- **Endpoints**: the 16 KB submit cap is above the largest real answer set
  (at most 5 questions, 500 characters each, ~7.5 KB fully in CJK);
  shop identity only from the session token; CORS on every
  response including auth refusals; `products=` parsing (empty vs absent);
  rate limits and per-token cap before DB reads; duplicates return 200.
- **Exactly-once storage**: per-order advisory lock across surveys and
  surfaces, legacy table checked, usage claim in the same transaction,
  redacted orders never re-stored.
- **Targeting**: order value with currency precision, first/returning,
  country, language, products, sample, dates in the store's zone, answer cap
  from the live count, rotation.
- **Time zones**: range edges and trend days probed for DST-at-midnight zones
  (Santiago, Havana, Beirut), half-hour and 45-minute offsets, Lord Howe's
  30-minute DST; always one bucket per calendar day, window starts at local
  midnight.
- **Analytics**: per-currency sums and AOV denominators, country filter
  disables the answer rate instead of faking one, previous-period comparison,
  CSV columns appended (positions kept).
- **Migration** `20261025090000_option_countries`: additive, defaults to
  every country; applied cleanly on a database holding older data.
- **Presets**: 23 markets, no duplicate keys or countries, ≤ 9 answers each,
  every generic label translated in all ten template languages.
- **GDPR / uninstall**: redact deletes answers, order cache, checkout loads,
  sync rows and scrubs stored data-request exports; deferred batches drain
  without a merchant visit; uninstall nulls the token, drops sessions and
  queued writes, resets the plan; shop/redact skips a reinstalled shop.
- **AI**: there is no AI feature and no OpenRouter (or other model) call
  anywhere, so nothing depends on an external model being up.
- **Support email**: `sourcetracsupport@gmail.com` (`shared/support.ts`) is
  the only address in the app.
- **Links**: every internal admin link and nav entry points at an existing
  route; SSR render of the editor sections (all three plans), presets, product
  picker, languages (incl. RTL), preview and quick start: no crash, no raw keys.

## Not fixable here

- How Polaris renders the admin and the checkout block on a real store
  (`cdn.shopify.com` is blocked in this container), App Bridge's product
  picker, and Shopify's `storage` lifetime in a real checkout.
- Country names come from `Intl.DisplayNames`; the server's ICU and a
  browser's may name a few countries differently, which React reports as a
  hydration text mismatch in the console. It does not affect what is stored.
