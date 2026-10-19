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
  "sourcetrac-order-admin": "admin.order-details.block.render",
  "sourcetrac-customer-admin": "admin.customer-details.block.render",
};

/**
 * Flow triggers are not UI extensions: no target, no bundled module. They are
 * checked against their own rules below.
 */
const FLOW_TRIGGERS = {
  "sourcetrac-flow-trigger": "sourcetrac-survey-answered",
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

  // network_access with no allowed_urls grants the capability but no host, so
  // every fetch is rejected at runtime and the survey silently never loads.
  // This exact omission shipped once, which is why it is asserted here.
  const allowed = contents.match(/^allowed_urls = \[(.+)\]$/m)?.[1] ?? "";
  if (!allowed.includes("http")) problems.push("allowed_urls does not name any host");
  const source = module && fs.existsSync(`extensions/${name}/${module.replace("./", "")}`)
    ? fs.readFileSync(`extensions/${name}/${module.replace("./", "")}`, "utf8")
    : "";
  // `process` does not exist in the extension Web Worker; reading it crashes the block.
  if (/process\.env/.test(source)) problems.push("extension source reads process.env, which is undefined at runtime");
  // From api_version 2025-10 the CLI calls the default export as a plain
  // function, and the old React/remote-ui binding crashes on React 19. Code
  // written for it rendered nothing at all, in the editor and on live orders.
  if (source && /@shopify\/ui-extensions-react|@remote-ui\//.test(source)) {
    problems.push("extension imports the old React/remote-ui binding, which cannot run on api_version 2026-07");
  }
  if (source && !source.includes('"@shopify/ui-extensions/preact"')) {
    problems.push("extension does not import @shopify/ui-extensions/preact, so host signals never reach Preact");
  }
  const apiUrl = source.match(/const API_URL = "([^"]+)"/)?.[1];
  if (source && !apiUrl) problems.push("could not find a literal API_URL");
  if (apiUrl && !allowed.includes(apiUrl)) {
    problems.push(`allowed_urls does not cover API_URL ${apiUrl}`);
  }

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

for (const [name, expectedHandle] of Object.entries(FLOW_TRIGGERS)) {
  const file = `extensions/${name}/shopify.extension.toml`;
  const contents = fs.readFileSync(file, "utf8");
  const problems = [];

  const uid = contents.match(/^uid = "(.+)"$/m)?.[1];
  const handle = contents.match(/^handle = "(.+)"$/m)?.[1];
  const type = contents.match(/^type = "(.+)"$/m)?.[1];
  const apiVersion = contents.match(/^api_version = "(.+)"$/m)?.[1];

  if (!uid || !UUID.test(uid)) problems.push(`uid is not a uuid: ${uid}`);
  if (type !== "flow_trigger") problems.push(`type is ${type}, expected flow_trigger`);
  // The handle is what flowTriggerReceive targets, so it must match the constant
  // in app/lib/sync.server.ts (FLOW_TRIGGER_HANDLE).
  if (handle !== expectedHandle) problems.push(`handle is ${handle}, expected ${expectedHandle}`);
  if (apiVersion !== "2026-07") problems.push(`api_version is ${apiVersion}, expected 2026-07`);
  // A trigger with no fields sends no data and Flow cannot render the payload.
  if (!contents.includes("[[settings.fields]]")) problems.push("no settings.fields declared");

  if (problems.length) {
    failed = true;
    console.error(`FAIL ${name}`);
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log(`ok   ${name} -> flow_trigger ${handle}`);
  }
}

process.exit(failed ? 1 : 0);