# Decisions taken while fixing BUGS.md

Each entry: the bug, what was chosen, and why. Shopify documentation decides
first; otherwise the option safest for merchants and their data.

- **C1** (backfill Option id collision): the already-shipped migration is edited in place rather than adding a new one, because a database with 2+ shops can never have applied it; `prisma migrate deploy` ignores the checksum change on single-shop databases that did apply it (verified locally). Backfilled option ids become `bf-option-<shop>-<channel>`.

## Steps for the repository owner (not done here: deploys or touching real data)

1. **C1 — only if a production deploy already failed on `20261012095226_multi_question_survey`.** Run `npx prisma migrate status` against production. If that migration is listed as failed: check whether its tables exist (`\dt "Survey"`). If they do not, run `npx prisma migrate resolve --rolled-back 20261012095226_multi_question_survey` and redeploy. If they do (partial apply), they hold no merchant data (the backfill aborted); drop the nine new tables and two enums the migration creates, then resolve and redeploy. Take a Neon branch/snapshot first.

