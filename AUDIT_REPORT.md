# Security & logic audit report — SourceTrac

Conducted 2026-10-12 against the current `main`. Scope: the logic/security/
completeness audit brief. Where the brief's referenced upgrade plan and the code
disagree, **the code wins** and the disagreement is recorded here and in
`COMPLIANCE_MATRIX.md`.

Every fix below has a regression test that fails on the old code (or, for the
"Checked: safe" items, the grep/test that proves the surface is already closed).

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low.

---

## Fixed findings

### F-001 — One checkout token could write unlimited forged responses
- **Severity:** 🟠 High
- **Area:** Response submission (C2)
- **Status:** Fixed
- **How it could happen:** Anyone who completes a checkout obtains a valid
  session token. The per-order rate bucket is keyed on a value the caller
  chooses, so one token plus 200 made-up order ids got 200 fresh buckets and
  wrote 200 forged answers with forged `orderTotal`/`currency`, poisoning the
  channel and revenue report and burning the shop's free cap and Neon compute.
- **Impact:** Wrong merchant numbers; free-tier exhaustion.
- **Where:** `app/routes/api.survey-responses.tsx` → `action`
- **Fix:** `consumeTokenSubmission` (in `app/lib/rate-limit.server.ts`) caps a
  single session token at `MAX_SUBMISSIONS_PER_TOKEN` (2) responses, keyed on the
  token's `jti` and expiring at its `exp`, checked **before** any DB read.
- **Test:** `tests/unit/token-submission-limit.test.ts`
- **Commit:** `fix(security): cap responses per checkout session token`

### F-002 — Free response cap could be exceeded by concurrent submissions
- **Severity:** 🟠 High
- **Area:** Plan gating / limits (C3)
- **Status:** Fixed
- **How it could happen:** The cap was decided from a read-then-write count, so
  20 simultaneous submissions could all pass the check before any incremented,
  letting a Free shop exceed the cap and locking in extra data.
- **Impact:** Plan bypass; wrong enforcement.
- **Where:** `app/lib/answers.server.ts` → `submitAnswers` / `claimUsageSlot`
- **Fix:** `claimUsageSlot` performs an atomic conditional increment
  (`UPDATE … SET count = count + 1 WHERE count < cap RETURNING`), with an
  `ON CONFLICT … DO NOTHING` insert for the first-of-month row. Exactly one
  concurrent claim takes the final slot.
- **Test:** `tests/db-verification-cap.test.ts` ("simultaneous claims")
- **Commit:** `fix(logic): enforce the free cap atomically`

### F-003 — Revenue report counted fake, unverified orders
- **Severity:** 🟠 High
- **Area:** Response submission / revenue (C2)
- **Status:** Fixed
- **How it could happen:** `orderTotal` and `currency` arrive from the browser
  and could be forged; the dashboard summed them directly.
- **Impact:** Inflated channel/revenue numbers merchants rely on.
- **Where:** `app/lib/survey-analytics.server.ts`, `app/lib/answers.server.ts`,
  `app/lib/webhooks.server.ts`
- **Fix:** New `Response.verified` / `Response.unverifiedFailed` columns
  (migration `20261012140000_response_verification`). A response is verified when
  its order is known and countable; `upsertOrderCache` reconciles v2 responses
  and stores the **real** total; `markUnverifiedFailedResponses` flips unanswered
  ones after 24 h; revenue counts verified orders only; pending is never `$0.00`.
- **Test:** `tests/db-verification-cap.test.ts`
- **Commit:** `fix(logic): verify orders before counting revenue`

### F-004 — A buyer could create arbitrary order tags
- **Severity:** 🟡 Medium
- **Area:** Injection / sync (C4)
- **Status:** Fixed
- **How it could happen:** The `{channel}` placeholder is filled from the
  buyer's free-text "Other" answer and then written as a Shopify tag. A comma
  splits one tag into several, so "a,b,c" created three arbitrary tags.
- **Where:** `app/lib/sync.server.ts` → `sanitizeTag`
- **Fix:** Tags are lower-cased, stripped of commas/control characters/quotes,
  reduced to a safe character set (letters of any script, digits, `-_.:`), and
  capped at 40 characters.
- **Test:** `tests/unit/tag-sanitize.test.ts`
- **Commit:** `fix(security): sanitize order tags built from buyer text`

### F-005 — Flow payloads and metafield values could exceed Shopify's limits
- **Severity:** 🟡 Medium
- **Area:** Injection / sync (C4)
- **Status:** Fixed
- **How it could happen:** An unbounded free-text channel label produced a Flow
  payload over 50,000 bytes, which `flowTriggerReceive` rejects **silently** —
  the merchant's flow just stops with no error.
- **Where:** `app/lib/sync.server.ts` → `truncateForPayload`, `runSyncKind`
- **Fix:** `truncateForPayload` (byte-aware, multibyte-safe, appends `…`) caps
  the Flow `"Channel label"` and metafield values; `MAX_FLOW_PAYLOAD_BYTES`
  (45,000) is enforced before the call.
- **Test:** `tests/unit/tag-sanitize.test.ts`
- **Commit:** `fix(sync): cap Flow payload and metafield size`

### F-006 — CSV export was unbounded
- **Severity:** 🟡 Medium
- **Area:** Cost / DoS (C6)
- **Status:** Fixed
- **How it could happen:** A large shop could generate an arbitrarily large CSV
  in one request, risking an OOM on the 512 MB Render free instance.
- **Where:** `app/routes/app.export_.csv.tsx`
- **Fix:** `MAX_CSV_ROWS = 50_000`; the response carries
  `X-SourceTrac-Truncated` so the client can warn instead of presenting a
  partial file as complete.
- **Commit:** `fix(cost): cap the CSV export row count`

### F-007 — Flow trigger contract test could no longer see the payload
- **Severity:** 🔵 Low
- **Area:** Tests
- **Status:** Fixed
- **Where:** `tests/unit/flow-trigger-contract.test.ts`
- **Fix:** The contract test now parses the `flowPayload` object literal (the
  payload moved into a variable in F-005). The TOML keys are still asserted
  verbatim, so a rename on either side still fails loudly.

## Checked: safe (no code change required)

### F-008 — Tenant isolation of admin routes
- **Status:** Checked: safe
- **Evidence:** Every admin loader/action gets the shop from
  `authenticate.admin` → `ensureShop(session)`, never from params or form
  fields. `getSurveyRow(shopId, surveyId)` uses
  `findFirst({ where: { id, shopId } })`; `reorderSurveys` uses
  `updateMany({ where: { id, shopId } })`; `getEditorSurvey`, `deleteSurvey`,
  `setSurveyStatus`, `duplicateSurvey` all re-fetch by `(shopId, id)` first.
  Response detail / CSV use `shop.id` from the session. In-memory caches
  (`getCompiledConfig`, `ordersCount`) are keyed by `shopId`.

### F-009 — Auth surfaces
- **Status:** Checked: safe
- **Evidence:** Extension routes call `authenticate.public.checkout` (token
  signature/exp/aud verified; shop from `dest`). Admin blocks call
  `verifyIdToken` (shop from `dest`; body `shop` ignored —
  `tests/db-admin-survey-context.test.ts`). Webhooks call
  `authenticate.webhook` (HMAC over the raw body) before any side effect.

### F-010 — Free plan limits differ from the plan
- **Severity:** 🟡 Medium
- **Area:** Plan gating (C3)
- **Status:** Accepted (documented divergence — code wins)
- **Detail:** The brief's Appendix 1 states Free = 100 responses/month, 1 active
  survey, 2 questions. The shipped code enforces `FREE_RESPONSE_CAP = 50`
  server-side and applies global limits (`MAX_ACTIVE_SURVEYS = 10`,
  `MAX_QUESTIONS = 5`) to every plan; it does not tie survey/question counts to
  the plan.
- **Why not changed:** Per the audit rule "where the plan and the code disagree,
  the code wins". The constant is interpolated into merchant-facing help and the
  plans page, so it is internally consistent; the number is a product decision,
  not a defect. Recorded so the divergence is visible.
- **Follow-up:** raise `FREE_RESPONSE_CAP` to 100 and, if desired, gate
  survey/question counts on the plan — tracked in `FUTURE_TASKS.md`.

### F-011 — Advanced options not grouped under a collapsed "Advanced"
- **Severity:** 🔵 Low
- **Area:** UI (Phase H)
- **Status:** Accepted (polish, deferred)
- **Detail:** Sample %, dates, response limit and min/max selections render
  inline in their sections rather than under an "Advanced" disclosure.
- **Follow-up:** `FUTURE_TASKS.md`.

### F-012 — Page descriptions use the product's own wording
- **Severity:** 🔵 Low
- **Status:** Accepted (documented divergence — code wins)
- **Detail:** Every page already carries a one-line description; the wording
  differs from the brief's suggested copy (e.g. Results = "How buyers answered
  across your surveys."). Same purpose, already translated across 10 locales.

### F-013 — Rate-limit backstops and costly-flood defence
- **Status:** Checked: safe
- **Evidence:** `consumeShopBackstop` never refuses a known order, so made-up
  ids cannot lock real buyers out. Invalid/limited requests are rejected before
  DB access via the in-memory config cache and the limiters; the submit route
  caps the body at 16 KB before parsing.

### F-014 — Injection surfaces
- **Status:** Checked: safe
- **Evidence:** No `dangerouslySetInnerHTML`/`innerHTML` anywhere in `app/` or
  `extensions/`. `escapeCsvValue` prefixes `= + - @` (and leading-whitespace
  variants); `csvFilename` uses only a date. All Prisma access is parameterised;
  no `ILIKE` search exists. React renders all merchant/buyer text as text.

### F-015 — Health endpoints never touch the database
- **Status:** Checked: safe
- **Evidence:** `/healthz` returns a constant JSON body; `/readyz` requires
  `x-retention-secret` and 404s (without a query) otherwise.

### F-016 — Secrets stay server-side
- **Status:** Checked: safe
- **Evidence:** `grep -o "process\.env\.[A-Z_]*" build/client/assets/*.js` is
  empty; extension bundles read a literal `API_URL`. The Partner/Admin tokens
  live only in server env and are never returned to the client.

---

## Manual test checklist for the founder

1. **Logic map.** Open a survey → **Logic map** tab. Add a follow-up from a
   choice question; edit a rule; remove a rule; change answers in "Try it as a
   shopper" and watch questions flip between Shown/Skipped; remove an option a
   rule referenced and confirm the warning appears.
2. **Free plan.** On Free, try to add a 6th question (button disabled), create
   an 11th active survey (blocked), and exceed the response cap by direct POST
   (blocked server-side). Confirm the calm upgrade prompt, no pressure wording.
3. **Paid → downgrade.** Subscribe on a development store (free to test), then
   downgrade; confirm no data is lost and sync/admin blocks stop.
4. **Verification.** Place a test order and submit a response; confirm it moves
   from "Pending" to verified once the order webhook lands, and that revenue
   updates. Submit with a fake order id; confirm it never counts as revenue.
5. **Injection.** Type `<b>test</b>` and `=1+1` into a text answer; view it in
   Responses (plain text) and open the CSV in a spreadsheet (shown as text, not
   a formula).
6. **UI.** Confirm each page shows its one-line description and that loading
   states keep the layout stable at 375 px and desktop width.
