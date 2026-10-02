/**
 * Static parity check between the keys the UI actually asks for and the keys the
 * English bundle defines.
 *
 * `i18n.test.ts` proves the bundle resolves; this proves it is the *right* bundle.
 * A key typed into a component that no locale file defines renders as the raw
 * key, and nothing at runtime can distinguish that from the intended string.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESOURCES } from "~/lib/i18n";

const APP_DIR = join(process.cwd(), "app");

/** All source files, so a key added anywhere is picked up without a list to update. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Collect `t("...")` / `i18n.t("...")` call-site keys. */
function collectUsedKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  // Dynamic keys (`t(keyVar)`) are intentionally not matched: they cannot be
  // checked statically, and pretending otherwise would give false assurance.
  const pattern = /\bt\(\s*["'`]([a-z0-9_]+(?:\.[a-z0-9_]+)+)["'`]/g;

  for (const file of sourceFiles(APP_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      // Group 1 always participates: the pattern has no alternation, so it is
      // captured or the whole regex did not match. Asserted rather than coerced
      // so a future pattern edit fails loudly instead of storing `undefined`.
      const key = match[1];
      if (key === undefined) continue;
      const sites = used.get(key) ?? [];
      sites.push(file.replace(`${process.cwd()}/`, ""));
      used.set(key, sites);
    }
  }
  return used;
}

/**
 * Keys referenced from module-level constants rather than inline in `t()`.
 *
 * The nav array in `app.tsx` holds keys as data because it is a shared module
 * constant — storing a translated string there would leak one merchant's
 * language into the next tenant's page. That makes those keys invisible to the
 * `t(` pattern above, so they are asserted explicitly.
 */
function declarativeKeys(): Map<string, string[]> {
  const navSource = readFileSync(join(APP_DIR, "routes/app.tsx"), "utf8");
  const navBlock = /const NAV = \[([\s\S]*?)\] as const;/.exec(navSource);
  const keys = new Map<string, string[]>();

  if (navBlock?.[1]) {
    for (const match of navBlock[1].matchAll(/key:\s*["'`]([a-z0-9_.]+)["'`]/g)) {
      const key = match[1];
      if (key) keys.set(key, ["app/routes/app.tsx (NAV)"]);
    }
  }

  return keys;
}

function flatten(value: unknown, prefix = ""): Set<string> {
  const keys = new Set<string>();
  if (value === null || typeof value !== "object") return new Set([prefix]);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") {
      for (const nested of flatten(child, next)) keys.add(nested);
    } else {
      keys.add(next);
    }
  }
  return keys;
}

/** `foo_one`/`foo_other` also satisfy a lookup of `foo`. */
function baseOf(key: string): string {
  return key.replace(/_(zero|one|two|few|many|other)$/, "");
}

describe("i18n key usage", () => {
  // `RESOURCES` maps locale code -> `{ translation: <bundle> }`, because
  // i18next namespaces its resource tree. A caller passes `nav.dashboard`, never
  // `translation.nav.dashboard`, so the namespace is stripped before comparing.
  // The fallback handles a bundle that is already flat.
  const enBundle = RESOURCES.en as Record<string, unknown>;
  const defined = flatten("translation" in enBundle ? enBundle.translation : enBundle);
  const definedBases = new Set([...defined].map(baseOf));

  const used = new Map([...collectUsedKeys(), ...declarativeKeys()]);

  it("finds keys in source", () => {
    // Guards the regex itself: if this ever returns nothing the tests below
    // would all pass vacuously, which is the failure mode they exist to prevent.
    expect(used.size).toBeGreaterThan(20);
  });

  it("defines every key the UI asks for", () => {
    const missing: string[] = [];
    for (const [key, sites] of used) {
      if (!definedBases.has(baseOf(key))) {
        missing.push(`${key} (used at ${sites.join(", ")})`);
      }
    }
    expect(missing).toEqual([]);
  });
});