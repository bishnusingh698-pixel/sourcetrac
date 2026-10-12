/**
 * The Flow trigger wire contract.
 *
 * `flowTriggerReceive` silently ignores a payload whose keys do not match the
 * trigger's declared fields: no error, no workflow run. The extension TOML lists
 * the fields the merchant can use, and `runSyncKind` builds the payload in
 * app/lib/sync.server.ts. Nothing else keeps those two in step, and a rename on
 * either side would stop every merchant's flow with no signal at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function tomlFieldKeys(dir: string): { reference: string[]; custom: string[] } {
  const toml = readFileSync(join(ROOT, `extensions/${dir}/shopify.extension.toml`), "utf8");
  const blocks = toml.split("[[settings.fields]]").slice(1);
  const reference: string[] = [];
  const custom: string[] = [];
  for (const block of blocks) {
    const type = block.match(/type = "(.+)"/)?.[1] ?? "";
    if (type.endsWith("_reference")) {
      reference.push(type);
    } else {
      const key = block.match(/key = "(.+)"/)?.[1];
      if (key) custom.push(key);
    }
  }
  return { reference, custom };
}

describe("Flow trigger payload matches its declared fields", () => {
  it("declares the fields the backend sends", () => {
    const { reference, custom } = tomlFieldKeys("sourcetrac-flow-trigger");
    const syncSource = readFileSync(join(ROOT, "app/lib/sync.server.ts"), "utf8");
    const payload = syncSource.match(/payload:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";

    // A reference field is sent under a fixed payload key, not its `type`.
    expect(reference).toContain("order_reference");
    expect(payload).toContain("order_id:");

    // Every custom field key must appear verbatim in the payload object,
    // whether it is written bare or as a quoted key (spaces need quotes).
    expect(custom.length).toBeGreaterThan(0);
    for (const key of custom) {
      const present = payload.includes(`${key}:`) || payload.includes(`"${key}":`);
      expect(present, `payload is missing the "${key}" field declared in the TOML`).toBe(true);
    }
  });

  it("names the same handle as the sync code calls", () => {
    const toml = readFileSync(
      join(ROOT, "extensions/sourcetrac-flow-trigger/shopify.extension.toml"),
      "utf8",
    );
    const handle = toml.match(/^handle = "(.+)"$/m)?.[1];
    const syncSource = readFileSync(join(ROOT, "app/lib/sync.server.ts"), "utf8");
    const constant = syncSource.match(/FLOW_TRIGGER_HANDLE = "(.+)"/)?.[1];
    expect(constant).toBe(handle);
  });
});
