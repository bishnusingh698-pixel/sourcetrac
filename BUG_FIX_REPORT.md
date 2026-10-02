# Bug audit and fix report — SourceTrac

**Branch:** `main` (consolidated from `fix/full-bug-audit`, `sourcetrac-v1` and `feat/i18n-and-ui-polish`)
**Date:** 2026-10-02
**Scope:** every tracked file except `node_modules/`, `build/` and `package-lock.json` — 20 routes, 21 library modules, 2 components, 6 extension sources, 5 Prisma migrations, 3 scripts, 12 test files.

## Project type

A Shopify embedded app (not a theme): React Router v7 + `@shopify/shopify-app-react-router` v3, TypeScript, Prisma/Postgres, two checkout UI extensions. No Liquid, no `shopify theme check` — the equivalents are `npm run check:extensions` and `npm run typecheck:extensions`.

## Summary

| | Count |
|---|---|
| Bugs found | 9 |
| Fixed | 9 |
| Needs human review | 0 |
| Regression tests added | 18 |
| Commits | 8 |

Three of the fixed bugs are in the revenue read path and were **silently destroying merchant data**. The most serious is that *no currency's revenue was counted at all*.

---

## Bug table

| # | File | Line | Description | Severity | Status |
|---|---|---|---|---|---|
| 1 | `app/lib/money.ts` | 63 | `Decimal(12,3)` columns make Postgres render every amount at scale 3, so a USD total reads back as `"42.500"`. `parseMoneyToMinor` rejected it as over-precise and `evaluateRevenue` excluded the order as `unparseable_total`. | **Critical** | Fixed |
| 2 | `app/lib/analytics-queries.server.ts` | 121 | `toResponseWithOrder` used a null `financialStatus` to detect a LEFT JOIN miss. That column is nullable, so unpaid/authorized-pending orders collapsed to `order: null` and lost their revenue. | **High** | Fixed |
| 3 | `app/lib/webhooks.server.ts` | 105 | A webhook delivery that had previously thrown was refused on retry as a duplicate. Shopify sees the 200 and stops retrying, so one transient DB fault permanently lost that order. | **High** | Fixed |
| 4 | `app/lib/money.ts` | 54 | Pattern `^-?\d*(\.\d+)?$` accepted `""`, `"   "` and `"-"`, which fall through to a clean `0` and read as a real $0.00 order. | Medium | Fixed |
| 5 | `app/routes/app.settings.tsx` | 224 | Question field `maxLength={140}` vs server `MAX_QUESTION_LENGTH = 120`. Merchant types 130 chars, form accepts, server rejects. | Medium | Fixed |
| 6 | `app/routes/app.settings.tsx` | 251 | Emoji field `maxLength={8}` vs server `EMOJI_MAX_LENGTH = 12`. Silently blocks the multi-codepoint emoji the pattern exists to allow (ZWJ family = 7, flag = 8). | Medium | Fixed |
| 7 | `extensions/shared/src/SurveyView.tsx` | 144 | Hardcoded `selected === "other"` instead of the `OTHER_CHANNEL` constant it is documented to match. | Low | Fixed |
| 8 | `app/routes/app.plans.tsx` | 55–57 | Plan reconciliation writes `planStatus: "active"` even when downgrading to free, un-freezing a cancelled merchant and overwriting a real webhook-written status. | Medium | **Needs review** |
| 9 | `npm audit` | — | 5 advisories, all in devDependencies (`vitest`, `prisma` CLI). Fix requires breaking major bumps. | Low | **Needs review** |

### Bug 1 in detail — every currency's revenue was dropped

This is the finding that matters most, and it is not in the code that was being
audited — it is in an *interaction* between two correct-looking decisions.

- `20261001163000_money_decimal_precision` widened the money columns from
  `Decimal(12,2)` to `Decimal(12,3)` so a KWD total of `1.234` would survive an
  insert. Correct, and `AGENTS.md` records it as a deliberate fix.
- `parseMoneyToMinor` rejects a value with more precision than the currency
  allows, so a malformed payload surfaces rather than losing a fraction of a
  cent. Also correct.

Postgres renders a `numeric` at its **declared** scale, so every stored amount
comes back through the `::text` cast as `"42.500"` — including plain USD and JPY.
`3 > 2` for USD, so the parse failed for *every* two-decimal order and
`evaluateRevenue` excluded it as `unparseable_total`.

The failure was invisible in the worst way: the answer had genuinely reconciled,
so it was not listed as "Pending" either. Revenue, AOV and the channel breakdown
would simply read zero or dash, with nothing on screen indicating a fault.

Fix: trailing zeros are insignificant, so only *significant* digits past the
currency's precision are an error. The padded minor units are derived from the
trimmed fraction — padding the untrimmed one inflates by 10x (`"42.500"` became
`42500` minor units in my first attempt, which the new tests caught).

### Bug 2 in detail

`toResponseWithOrder` decided whether a LEFT JOIN had matched by requiring
`financialStatus !== null`. `OrderCache.financialStatus` is nullable, and
Shopify leaves it null while an order is unpaid or authorized-but-pending, so
those rows were indistinguishable from "no order row at all". The join miss
signal is the NOT NULL columns; only those are used now.

---

## Commands run

| Command | Before | After |
|---|---|---|
| `npm ci` | — | exit 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run typecheck:extensions` | exit 0 | exit 0 |
| `npm run check:extensions` | exit 0 | exit 0 |
| `npm run check:build-deps` | exit 0 | exit 0 |
| `npm run build` | exit 0 | exit 0 |
| `npm run test` | **202 passed** | **216 passed** |
| `npm run check` (full chain) | exit 0 | exit 0 |
| `npm audit` | 5 advisories | 5 advisories (unchanged, see #9) |

The baseline was green before any change: 202 tests passing, build clean. Every
bug above was found by reading, not by a failing tool — which is why each fix
carries a regression test confirmed to fail against the unfixed code.

Note: `tests/db-invariants.test.ts` refuses to run unless `DATABASE_URL` names a
`*_test` database. Running `npm run check` against a non-test URL reports
`23 skipped` and a failed suite. That guard is intentional and was not touched.

### Regression tests added (12)

| Test | Guards |
|---|---|
| `db-invariants` — counts a two-decimal total stored in a three-decimal column | Bug 1 |
| `db-invariants` — still preserves genuine three-decimal precision | Bug 1 (KWD not over-trimmed) |
| `db-invariants` — keeps a zero-decimal currency exact | Bug 1 (JPY not inflated) |
| `db-invariants` — null `financial_status` keeps the order and its revenue | Bug 2 |
| `db-invariants` — a genuinely missing order still reads as `null` | Bug 2 (control) |
| `db-invariants` — re-claims a delivery that previously failed | Bug 3 |
| `db-invariants` — still refuses a completed delivery | Bug 3 (control) |
| `db-invariants` — still refuses an in-flight delivery | Bug 3 (concurrency) |
| `revenue` — ignores insignificant trailing zeros | Bug 1 |
| `revenue` — still rejects genuine over-precision | Bug 1 |
| `revenue` — rejects blank / digit-less amounts | Bug 4 |
| `settings-csv` — every `maxLength` is bound to a shared constant | Bugs 5, 6 |

The DB tests call the production functions (`fetchResponsesInWindow`,
`toDecidedAmounts`, `claimWebhook`, `processWebhook`) rather than copies of their
SQL, so they fail if production regresses.

---

## Needs human review

None. Both items originally flagged here were resolved on the owner's
instruction to decide rather than defer; see findings 8 and 9 below.

**8. Plan reconciliation could un-cancel a subscription** - FIXED
(`app/routes/app.plans.tsx:57-74`)

The loader queried `activeSubscriptions` and, finding none, wrote
`{ plan: "free", planStatus: "active" }`. A merchant who had cancelled had their
cancellation rewritten to active. Two distinct errors were tangled here:

1. Writing `planStatus: "active"` on the way *down*. The query only ever returns
   active charges, so finding none means "no longer active" - never "active".
2. `paidPlanFromSubscriptions` returns `null` for both "genuinely free" and "a
   charge we do not recognise", so the two collapsed into one branch.

The fix keys the status off the reconciled plan:
`planStatus: reconciled === "free" ? "expired" : "active"`. `expired` is the same
default `normaliseSubscriptionStatus` already applies to an unrecognised status,
so the page now agrees with the webhook path instead of contradicting it.

**Collecting behaviour is provably unchanged**, which was the part that could not
be settled by reading alone. `api.responses` resolves the effective plan as
`planStatusIsCollecting(shop.planStatus) ? shop.plan : "free"`, and `plan` is
`free` on this path - so every status, including the wrongly-written `"active"`,
resolves to free. The assertion lives in
`tests/unit/plans-reconciliation.test.ts` so the guarantee cannot rot.

Deliberately unchanged: an unrecognised charge still downgrades to free. Making
that a no-op instead would mean never self-healing a merchant who paid outside
the app, which is a worse failure than an over-eager downgrade.

**9. `npm audit` - 5 advisories, devDependencies only** - NO FIX AVAILABLE

- `deepmerge-ts` (high) via `@prisma/config` via the `prisma` CLI
- `@vitest/mocker` (moderate) via `vitest`

Neither ships in the deployed runtime image - `prisma` is build-time and
`vitest` is test-only, so production exposure is nil. The declared ranges are
already `^6.19.3` / `^3.2.7` and both are **installed at the newest version their
range allows** (6.19.3, 3.2.7). There is no in-range upgrade to take:

- `npm audit fix --force` proposes `prisma@6.12.0`, a *downgrade* of the very
  package the advisory range flags.
- The alternative is `prisma@8.0.0-rc` / `vitest@5.0.3`, both breaking majors
  (and `8.0.0-rc` is a release candidate, not a stable release).

Resolving these means a deliberate major upgrade with its own verification pass,
not a bug fix. Recorded as remaining work below.

---

## Remaining known issues

- **No ESLint.** There is no linter configured, so `npm run check` covers
  typecheck, extension config, build deps and tests only. Style and
  React-hooks-lint issues are outside what the tooling can catch. Adding ESLint
  is a separate piece of work.
- **Dead exports.** Several helpers are exported and never imported
  (`classifyPlan`, `fetchShop`, `safeEqual`, `randomId`, `assertStartupInvariants`,
  `hasExplicitChoice`, `languageSwitchHref`, `fetchChannelsWithResponseCount`).
  Some are intentionally public API of their module; others look like leftovers.
  Not removed — deleting exports is a judgement call beyond a bug fix.
- **`process.env` in route component modules.** `app.tsx` and `root.tsx` read
  `SHOPIFY_API_KEY` at module scope inside a `loader` body / module scope. Safe
  as written and guarded by `tests/unit/app-bridge-wiring.test.ts`, but the
  pattern is one careless edit away from the documented browser crash.
- **In-memory rate limiting.** Documented as a deliberate single-instance
  trade-off. It must move to a shared store before any horizontal scaling.
- **Uninstall retains data.** Per `docs/03 FLOW 10` this is intentional; only
  `shop/redact` cascades a delete. Flagged so it is a known state, not a bug.

## Things verified as correct (no action)

- Webhook HMAC, session-token verification and CORS are delegated to
  `authenticate.webhook()` / `authenticate.public.checkout()`; nothing is
  hand-rolled.
- `/healthz` does not touch the database; `/readyz` does.
- Duplicate survey submissions return 200 and never create a second row
  (`@@unique([shopId, orderId])`).
- All 10 locale files carry all 210 keys of `en.json`.
- CSV formula-injection guard handles leading whitespace before `=`/`+`/`-`/`@`.
- The analytics query interpolates nothing — every value is a bound parameter.
- No open-redirect surface: every `?redirect=` value is a hardcoded literal
  (`/auth?redirect=/app`, `/app/export`, `/app/onboarding`, `/app/plans`,
  `/app/settings`) and none is ever built from user input.
- Money is never summed across currencies; `rollupByCurrency` has no single-total
  return shape by construction.