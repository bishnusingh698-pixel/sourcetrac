/**
 * Sanity check for the hand-authored extension configs. Shopify's generator
 * could not run in this environment, so these files are written by hand and
 * need a cheap guard against typos.
 */
const fs = require("node:fs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EXPECTED = {
  "sourcetrac-thank-you": "purchase.thank-you.block.render",
  "sourcetrac-order-status": "customer-account.order-status.block.render",
};

let failed = false;

for (const [name, expectedTarget] of Object.entries(EXPECTED)) {
  const file = `extensions/${name}/shopify.extension.toml`;
  const contents = fs.readFileSync(file, "utf8");
  const problems = [];

  const uid = contents.match(/^uid = "(.+)"$/m)?.[1];
  const target = contents.match(/^target = "(.+)"$/m)?.[1];
  const apiVersion = contents.match(/^api_version = "(.+)"$/m)?.[1];
  const module = contents.match(/^module = "(.+)"$/m)?.[1];

  if (!uid || !UUID.test(uid)) problems.push(`uid is not a uuid: ${uid}`);
  if (target !== expectedTarget) problems.push(`target is ${target}, expected ${expectedTarget}`);
  if (apiVersion !== "2026-07") problems.push(`api_version is ${apiVersion}, expected 2026-07`);
  if (!contents.includes("network_access = true")) problems.push("network_access is not enabled");
  if (!module || !fs.existsSync(`extensions/${name}/${module.replace("./", "")}`)) {
    problems.push(`module ${module} does not exist`);
  }

  if (problems.length) {
    failed = true;
    console.error(`FAIL ${name}`);
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log(`ok   ${name} -> ${target}`);
  }
}

process.exit(failed ? 1 : 0);