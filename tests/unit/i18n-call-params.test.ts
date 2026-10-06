/**
 * Static check that every `t("key", …)` call passes what its string needs.
 *
 * `i18n-usage.test.ts` proves a key exists. It cannot prove the call works:
 *
 *   - A key stored only as `foo_one` / `foo_other` satisfies "exists", but
 *     i18next only performs the plural lookup when `count` is passed. Without
 *     it, the merchant sees the raw key. `shell.cap_warning_body` shipped like
 *     that, rendering the literal text "shell.cap_warning_body" in the cap
 *     warning banner in every language.
 *   - A string with `{{min}}` called without `min` renders the braces verbatim.
 *     `onboarding.step2_body` shipped like that: "Choose the {{min}} to
 *     {{max}} ways customers find you".
 *
 * Neither is visible to the type system, so this reads the call sites.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESOURCES } from "~/lib/i18n";

const APP_DIR = join(process.cwd(), "app");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

function flatten(value: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") flatten(child, next, out);
    else out.set(next, String(child));
  }
  return out;
}

/** The argument text of a call, from just after `t(` to its closing paren. */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

type Call = { key: string; args: string; site: string };

function collectCalls(): Call[] {
  const calls: Call[] = [];
  // Literal keys only. Dynamic keys (`t(item.key)`) cannot be checked here.
  const pattern = /\bt\(\s*["']([a-z0-9_]+(?:\.[a-z0-9_]+)+)["']/g;
  for (const file of sourceFiles(APP_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const key = match[1];
      if (key === undefined) continue;
      const open = match.index + match[0].indexOf("(");
      const line = source.slice(0, match.index).split("\n").length;
      calls.push({ key, args: callArguments(source, open), site: `${file.replace(`${process.cwd()}/`, "")}:${line}` });
    }
  }
  return calls;
}

const en = flatten((RESOURCES.en as { translation: unknown }).translation);
const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Every English form of a key: the key itself, or its plural variants. */
function formsOf(key: string): string[] {
  const exact = en.get(key);
  if (exact !== undefined) return [exact];
  return [...en.entries()].filter(([k]) => PLURAL.test(k) && k.replace(PLURAL, "") === key).map(([, v]) => v);
}

describe("t() call parameters", () => {
  const calls = collectCalls();

  it("finds calls to check", () => {
    // Guards the scanner: an empty result would make every test below pass.
    expect(calls.length).toBeGreaterThan(100);
  });

  it("passes `count` to every key that exists only in plural forms", () => {
    const failures = calls
      .filter((call) => !en.has(call.key) && formsOf(call.key).length > 0)
      .filter((call) => !/\bcount\b/.test(call.args))
      .map((call) => `${call.key} at ${call.site}`);
    expect(failures).toEqual([]);
  });

  it("passes every {{placeholder}} the English string uses", () => {
    const failures: string[] = [];
    for (const call of calls) {
      const names = new Set(formsOf(call.key).flatMap((text) => [...text.matchAll(/{{(\w+)}}/g)].map((m) => m[1])));
      for (const name of names) {
        if (name && !new RegExp(`\\b${name}\\b`).test(call.args)) {
          failures.push(`${call.key} missing {{${name}}} at ${call.site}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("admin pages are translated", () => {
  /**
   * Every page under the admin shell must translate. Dashboard, Settings,
   * Export, Plans and Help once rendered hardcoded English while their keys sat
   * unused in all ten locale files, so a merchant who chose German saw German
   * navigation around English pages.
   */
  const routes = readdirSync(join(APP_DIR, "routes")).filter(
    (file) => /^app\..+\.tsx$/.test(file) && /export default function/.test(readFileSync(join(APP_DIR, "routes", file), "utf8")),
  );

  it("finds the admin pages", () => {
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of routes) {
    it(`${file} renders through a translator`, () => {
      const source = readFileSync(join(APP_DIR, "routes", file), "utf8");
      expect(source).toMatch(/useAdminI18n\(\)|createTranslator\(/);
    });
  }
});
