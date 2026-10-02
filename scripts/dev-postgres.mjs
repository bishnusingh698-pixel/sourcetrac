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
/**
 * Keep this process alive after the databases are up.
 *
 * Without it the `start` branch calls `process.exit(0)`, which takes the spawned
 * postgres down with it: the child is killed when its parent exits, so the
 * server is unreachable from the next command. Holding the process open is what
 * makes the server usable across separate invocations.
 */
const hold = process.argv.includes("--hold");

if (command === "start") {
  await db.initialise();
  await db.start();
  await db.createDatabase("sourcetrac");
  await db.createDatabase("sourcetrac_test");
  console.log(`postgres ready on :${PORT} (databases: sourcetrac, sourcetrac_test)`);

  if (hold) {
    console.log("holding; press Ctrl-C or run `node scripts/dev-postgres.mjs stop` to stop");
    // The stdin handle keeps the node event loop alive. Without it the loop
    // drains, the process exits, and postgres is torn down with it.
    process.stdin.resume();
    process.on("SIGINT", async () => {
      await db.stop();
      process.exit(0);
    });
  }
} else if (command === "stop") {
  await db.stop();
  console.log("postgres stopped");
} else {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}
