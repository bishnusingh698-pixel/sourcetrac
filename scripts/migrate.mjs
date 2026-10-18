#!/usr/bin/env node
// Applies pending Prisma migrations before the server starts.
//
// Neon's pooled host (`-pooler.`) runs PgBouncer in transaction mode, which
// does not hold the session-level advisory lock `prisma migrate deploy` takes.
// Migrations therefore run against the direct host: DIRECT_URL if set,
// otherwise DATABASE_URL with `-pooler` removed. The app itself keeps using
// the pooled DATABASE_URL.
//
// Neon suspends after 5 minutes idle and takes a few seconds to wake, so a
// connection failure is retried before giving up.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const pooled = process.env.DATABASE_URL;
if (!pooled) {
  console.error(JSON.stringify({ level: "error", msg: "migrate_missing_database_url" }));
  process.exit(1);
}

const direct = process.env.DIRECT_URL || pooled.replace("-pooler.", ".");
const attempts = 5;

// The installed CLI, not `npx prisma`: npx resolves the package again on every
// start, which cost several seconds of each cold start on Render's small CPU.
const local = new URL("../node_modules/.bin/prisma", import.meta.url);
const [command, args] = existsSync(local)
  ? [local.pathname, ["migrate", "deploy"]]
  : ["npx", ["prisma", "migrate", "deploy"]];

for (let attempt = 1; attempt <= attempts; attempt++) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: direct },
  });
  if (result.status === 0) process.exit(0);

  console.error(JSON.stringify({ level: "warn", msg: "migrate_attempt_failed", attempt, status: result.status }));
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
}

console.error(JSON.stringify({ level: "error", msg: "migrate_gave_up", attempts }));
process.exit(1);
