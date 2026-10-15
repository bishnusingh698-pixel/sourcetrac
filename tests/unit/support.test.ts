import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTranslator } from "~/lib/i18n";
import { LANGUAGES, type LanguageCode } from "~/lib/i18n/languages";
import {
  buildSupportMailto,
  SUPPORT_BODY_KEY,
  SUPPORT_EMAIL,
  SUPPORT_SUBJECT_KEY,
} from "@shared/support";

/**
 * The email support button is a review requirement: the App Store listing and
 * the app itself must offer a real way to reach a human. These tests cover the
 * link builder, the translated subject/body, and the one rule that keeps a
 * placeholder address from ever shipping again.
 */

describe("support mailto link", () => {
  it("targets the support address", () => {
    expect(buildSupportMailto()).toContain(`mailto:${SUPPORT_EMAIL}`);
  });

  it("encodes the subject and body", () => {
    const href = buildSupportMailto({
      shop: "a+b&c.myshopify.com",
      subject: "Help & support",
      body: "Line one\nLine two & more",
    });
    // A raw `&` would end the query string, so every value must be percent-encoded.
    expect(href).not.toContain("a+b&c.myshopify.com");
    expect(href).toContain("subject=Help%20%26%20support");
    expect(href).toContain(encodeURIComponent("Line two & more"));
  });

  it("fills every placeholder it knows", () => {
    const href = decodeURIComponent(
      buildSupportMailto({ shop: "s.myshopify.com", plan: "Growth", version: "1.2.3", page: "/app/plans" }),
    );
    expect(href).toContain("Shop: s.myshopify.com");
    expect(href).toContain("Plan: Growth");
    expect(href).toContain("App version: 1.2.3");
    expect(href).toContain("Page: /app/plans");
    expect(href).not.toContain("{shop}");
  });

  it("leaves a blank field as an empty value rather than a stray placeholder", () => {
    const href = decodeURIComponent(buildSupportMailto({ page: "/app" }));
    expect(href).toContain("Shop: \n");
    expect(href).not.toMatch(/\{(shop|plan|version|page)\}/);
  });
});

describe("support translations", () => {
  it("resolves in every locale with no raw key or leftover placeholder", () => {
    for (const { code } of LANGUAGES) {
      const t = createTranslator(code as LanguageCode);
      for (const key of [SUPPORT_SUBJECT_KEY, SUPPORT_BODY_KEY, "support.button_label", "support.body"]) {
        const value = t(key);
        expect(value, `${key} missing in ${code}`).not.toBe(key);
      }

      const body = t(SUPPORT_BODY_KEY);
      // The body template uses the same placeholders as `buildSupportMailto`.
      for (const name of ["shop", "plan", "version", "page"]) {
        expect(body, `support.mail_body missing {${name}} in ${code}`).toContain(`{${name}}`);
      }

      const href = decodeURIComponent(
        buildSupportMailto({ shop: "s.myshopify.com", subject: t(SUPPORT_SUBJECT_KEY), body }),
      );
      expect(href, `unfilled placeholder in ${code}`).not.toMatch(/\{(shop|plan|version|page)\}/);
    }
  });
});

/**
 * The button must stay wired in. This is the same class of silent failure as
 * the App Bridge wiring: removing it breaks nothing at build time and only shows
 * up as a merchant with no way to reach support.
 */
describe("support is reachable from the UI", () => {
  const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

  it("renders the button in the admin shell page header", () => {
    const shell = read("app/routes/app.tsx");
    expect(shell).toMatch(/<SupportIconButton/);
    expect(shell).toContain('slot="secondary-actions"');
  });

  it("renders the contact panel on the Help page", () => {
    const help = read("app/routes/app.help.tsx");
    expect(help).toMatch(/<SupportContactPanel/);
    // The address must come from the constant, never a hardcoded literal.
    expect(help).not.toMatch(/mailto:/);
  });

  it("renders a support link on the root error screen", () => {
    const root = read("app/root.tsx");
    expect(root).toMatch(/buildSupportMailto/);
    expect(root).toContain("SUPPORT_EMAIL");
  });

  it("renders a support link on the admin error screen", () => {
    const shell = read("app/routes/app.tsx");
    // The boundary and the normal shell both mount the icon button.
    const mounts = shell.match(/<SupportIconButton/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * One address, everywhere.
 *
 * The app must never show a placeholder (`support@example.com`) or a second,
 * unmonitored address to a merchant. Every `@`-bearing string in app/shared must
 * be the support address, except the `example.` domains used in fixtures — which
 * are not reachable from a UI.
 */
describe("no stray email addresses", () => {
  const ROOTS = ["app", "shared"];

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...files(full));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("uses only the support address in app and shared source", () => {
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const allowed = new Set([SUPPORT_EMAIL]);
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of files(join(process.cwd(), root))) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(email)) {
          const value = match[0];
          // Example domains and version-ish strings are not merchant-facing.
          if (/@(example\.(com|org|net)|.*\.myshopify\.com)$/.test(value)) continue;
          if (!allowed.has(value)) offenders.push(`${file.replace(`${process.cwd()}/`, "")}: ${value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
