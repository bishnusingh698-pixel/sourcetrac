/**
 * The browser downloads one language, not ten.
 *
 * All ten locale files used to be bundled into the admin's main chunk, about
 * 740 KB of JavaScript every page downloaded and parsed to show one of them.
 * The browser build now gets English only, and the shell loader sends the
 * merchant's language with its data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BUNDLED as BROWSER } from "~/lib/i18n/bundled-locales.browser";
import { createTranslator, languageStrings, LANGUAGES } from "~/lib/i18n";
import { shellTranslator } from "~/lib/i18n/use-admin-i18n";

const read = (relative: string) => readFileSync(join(__dirname, "../..", relative), "utf8");

describe("locale bundles", () => {
  it("gives the browser English only", () => {
    expect(Object.keys(BROWSER)).toEqual(["en"]);
  });

  it("keeps every language on the server", () => {
    for (const { code } of LANGUAGES) expect(languageStrings(code), code).not.toBeNull();
  });

  it("swaps the module only for the browser build", () => {
    const config = read("vite.config.ts");
    expect(config).toContain("plugins: [browserLocales, reactRouter(), tsconfigPaths()]");
    expect(config).toContain("if (options?.ssr");
  });

  it("sends the shell's language with its data and registers it before rendering", () => {
    const shell = read("app/routes/app.tsx");
    expect(shell).toContain("messages: language === DEFAULT_LANGUAGE ? null : languageStrings(language)");
    expect(shell).toContain("shellTranslator(language, messages)");
    expect(read("app/lib/i18n/use-admin-i18n.ts")).toContain("shellTranslator(language, messages)");
  });

  it("translates with strings handed over by the shell", () => {
    const strings = languageStrings("de");
    const t = shellTranslator("de", strings);
    expect(t("nav.dashboard")).toBe(createTranslator("de")("nav.dashboard"));
    expect(t("nav.dashboard")).not.toBe("nav.dashboard");
  });
});
