# Changes summary — SourceTrac

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
- `tests/unit/logic-tree.test.ts` — `buildLogicTree` (Phase G).

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
