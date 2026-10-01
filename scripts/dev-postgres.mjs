/**
 * Local development Postgres.
 *
 * The container has no Docker socket and no root, so system Postgres is not
 * available. `embedded-postgres` ships real Postgres binaries that run
 * unprivileged, which is enough to exercise migrations and the integration
 * tests against a genuine database rather than a mock.
 *
 * Usage: node scripts/dev-postgres.mjs start|stop
 */
import EmbeddedPostgres from "embedded-postgres";

const DATA_DIR = "/tmp/sourcetrac-pg";
const PORT = 5432;

const db = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "sourcetrac",
  password: "sourcetrac",
  port: PORT,
  persistent: true,
});

const command = process.argv[2] ?? "start";

if (command === "start") {
  await db.initialise();
  await db.start();
  await db.createDatabase("sourcetrac");
  await db.createDatabase("sourcetrac_test");
  console.log(`postgres ready on :${PORT} (databases: sourcetrac, sourcetrac_test)`);
  process.exit(0);
}

if (command === "stop") {
  await db.stop();
  console.log("postgres stopped");
  process.exit(0);
}

console.error(`unknown command: ${command}`);
process.exit(1);