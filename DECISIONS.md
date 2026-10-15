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

## Steps for the repository owner (not done here: deploys or touching real data)

1. **C1 — only if a production deploy already failed on `20261012095226_multi_question_survey`.** Run `npx prisma migrate status` against production. If that migration is listed as failed: check whether its tables exist (`\dt "Survey"`). If they do not, run `npx prisma migrate resolve --rolled-back 20261012095226_multi_question_survey` and redeploy. If they do (partial apply), they hold no merchant data (the backfill aborted); drop the nine new tables and two enums the migration creates, then resolve and redeploy. Take a Neon branch/snapshot first.

