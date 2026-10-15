# Decisions taken while fixing BUGS.md

Each entry: the bug, what was chosen, and why. Shopify documentation decides
first; otherwise the option safest for merchants and their data.

- **C1** (backfill Option id collision): the already-shipped migration is edited in place rather than adding a new one, because a database with 2+ shops can never have applied it; `prisma migrate deploy` ignores the checksum change on single-shop databases that did apply it (verified locally). Backfilled option ids become `bf-option-<shop>-<channel>`.
- **M1** (stale hidden answers): the server now drops answers to questions hidden by show-if instead of refusing the whole set, and the extension evaluates visibility in order like the server. Chosen because "never lose the answer" outweighs strictness on a field the buyer can no longer see.
- **M4** (one order answered twice): one answer set per order across all surveys, enforced with a per-order Postgres advisory lock inside the submit transaction, matching the existing `alreadyAnswered` rule. No new unique index, so no migration can fail on rows already duplicated in production.
- **M6** (edit/publish while a buyer is answering): archived options remain valid answers, and a submit carrying an older `surveyVersion` is not refused for `required` or for questions that no longer exist; every other rule still applies. The buyer's version is stored on the Response.
- **M7** (id-less submissions): Thank-you and Order-status submissions must carry an order id; id-less placements (on-site/link, behind feature flags) always go through the shop-wide backstop with no known-order exemption.
- **M3/L10** (token cap): the per-token cap now counts only stored answers, so failed attempts and backstop 429s before the order lands no longer lock a real buyer out of their own retries.
- **L11/L12/L39** (half-processed submits): the usage claim, insert and survey count are one transaction; a usage failure fails the request (the extension retries) instead of storing an uncounted, unflagged answer.
- **M19** (submit waits on Shopify): the inline sync now runs in the background, limited to the new response's rows; the buyer's response no longer waits on Shopify.
- **L17** (first-order targeting on Order-status): kept strict. The Order-status page has no first-order signal, and showing a first-order-only survey to an unknown buyer would put the wrong audience into the merchant's data; the misleading "rule stays inert" comments were corrected instead.
- **L18** (any order id can be answered): survey status and placement are now checked. Binding the order id to the token is not possible: Shopify's checkout session token carries no order claim.
- **C5** (template ids): rows keep unique database ids and remember the template's stable id in a new nullable `templateKey` column (additive migration); show-if, the channel report question and duplicated surveys are remapped from posted ids to saved ids. Storing stable ids as row ids was rejected because they collide on the global primary key.
- **H11** (archived rows come back): the Studio no longer receives archived questions/options, and an archived row that is posted back stays archived. Results still read them for their "(removed)" labels.
- **H14** (duplicate): a duplicate copies the *published* survey (what buyers see), not an unpublished draft, and now carries template provenance, design, rotation and learn-and-stop.
- **M23** (equal priorities): ties break on creation order (oldest first), so the winner is stable and matches the list order; new surveys still start at priority 0.
- **M26** (status from a save): a Studio save never changes status or priority; status goes through Activate/Pause (with their guards) and priority through reordering. Publishing a live survey with no placement is refused rather than silently showing nowhere.
- **M28** (editing answered questions): changing the *type* of a question that has answers is refused; relabelling options stays allowed so typos can be fixed.
- **I25** (missing revision): the Studio route now refuses a post without a revision (shown as a conflict). The library functions keep the optional parameter for internal callers, but the check is now an atomic conditional update.
- **L60** (setup wizard): a launch creates the survey as active in the same transaction as the create, so a retry cannot leave a duplicate.
- **C4** (reports read only the legacy table): the dashboard and export now read one union of legacy `SurveyResponse` rows the migration did not copy and every v2 `Response` that answered its survey's channel-report question; migrated `bf-option-<shop>-<value>` ids are folded back to their legacy value so history stays one channel. Answers without an order id (on-site/link) are left out of this order-level report.
- **M33** (rate over 100%): the rate's numerator is now "eligible orders placed in the window that have an answer", the same population as the denominator.
- **M34** (multi-choice revenue): kept full credit per chosen option (splitting an order's value would invent a model the merchant never chose) and added a note under every multiple-choice breakdown saying the amounts can exceed the total.
- **M30/L69** (large result sets): Results aggregates the newest 5,000 answers and says so when capped; both CSVs cap at 50,000 newest rows, read one extra row to detect truncation exactly, send `X-SourceTrac-Truncated`, and the Export page now warns.
- **L73** (Home numbers): an NPS question shows its NPS score; the confidence badge shows the number of answers the label was computed from.

## Steps for the repository owner (not done here: deploys or touching real data)

1. **C1 — only if a production deploy already failed on `20261012095226_multi_question_survey`.** Run `npx prisma migrate status` against production. If that migration is listed as failed: check whether its tables exist (`\dt "Survey"`). If they do not, run `npx prisma migrate resolve --rolled-back 20261012095226_multi_question_survey` and redeploy. If they do (partial apply), they hold no merchant data (the backfill aborted); drop the nine new tables and two enums the migration creates, then resolve and redeploy. Take a Neon branch/snapshot first.

2. **C5 — existing template surveys created before this fix** have show-if conditions pointing at ids that were never stored (follow-ups never show; the Studio refuses to save with `show_if_unknown`). They are not rewritten automatically because that would change merchant data. To repair one, open it in the Studio and re-pick the follow-up's condition (or delete and recreate it from the template). A query to find them: `SELECT q."surveyId" FROM "Question" q WHERE q."showIf" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Question" p WHERE p.id = (q."showIf"::jsonb->>'questionId'));`
3. **Deploy note:** this branch adds migration `20261015090000_template_keys` (two nullable columns, additive). `npm run start` applies it.
