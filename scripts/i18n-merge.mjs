#!/usr/bin/env node
/**
 * Merge translated strings into every locale file at once.
 *
 *   node scripts/i18n-merge.mjs <keys.json> [--target admin|templates]
 *
 * `keys.json` maps a dotted key to one string per language:
 *
 *   { "editor.look_title": { "en": "Look and wording", "de": "Aussehen und Text", ... } }
 *
 * - `admin` (default) writes nested keys into `app/lib/i18n/locales/<code>.json`.
 * - `templates` writes flat keys into `shared/templates/locales/<code>.json`.
 *
 * Every language the target ships must be present for every key, or nothing is
 * written: a missing language would otherwise render the English key in that
 * admin. Existing keys are overwritten, so the same file can fix a wording.
 *
 * Adding a whole new admin language is three steps:
 *   1. Add it to `LANGUAGES` in `app/lib/i18n/languages.ts` (code, names, flag,
 *      Intl locale).
 *   2. Copy `en.json` to `<code>.json` and translate it (or merge a full key file
 *      with this script), then register it in `bundled-locales.ts`.
 *   3. Run `npm test`: `tests/unit/i18n*.test.ts` fail on any missing key,
 *      placeholder or plural form.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : "admin";
if (!file || !["admin", "templates"].includes(target)) {
  console.error("usage: node scripts/i18n-merge.mjs <keys.json> [--target admin|templates]");
  process.exit(2);
}

const dir = target === "admin" ? "app/lib/i18n/locales" : "shared/templates/locales";
const codes = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));
const entries = Object.entries(JSON.parse(readFileSync(file, "utf8")));

const missing = [];
for (const [key, byLanguage] of entries) {
  for (const code of codes) {
    if (typeof byLanguage[code] !== "string" || byLanguage[code].length === 0) missing.push(`${key} [${code}]`);
  }
}
if (missing.length > 0) {
  console.error(`Not written. Missing translations:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

for (const code of codes) {
  const path = join(dir, `${code}.json`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const [key, byLanguage] of entries) {
    if (target === "templates") {
      data[key] = byLanguage[code];
      continue;
    }
    const parts = key.split(".");
    let node = data;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part];
    }
    node[parts.at(-1)] = byLanguage[code];
  }
  const out = target === "templates" ? Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : 1))) : data;
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}
console.log(`Merged ${entries.length} keys into ${codes.length} ${target} locales.`);
