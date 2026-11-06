/**
 * The app's navigation, pinned to Shopify's rules and to earlier merchant
 * feedback.
 *
 * - Shopify's own admin navigation (`<s-app-nav>`) is the menu, within its
 *   seven-item limit. The page body never repeats it: the app design
 *   guidelines ask apps not to replicate the app nav in the body, and Built
 *   for Shopify counts an app's own menu as an audit failure.
 * - Inside the body there is only secondary navigation: the current
 *   section's pages (`SectionNav`), small icon beside label, wrapping (never
 *   scrolling sideways, never overlapping), with `aria-current` on the page
 *   you are on; and a title-bar breadcrumb on the survey editor.
 *
 * `SectionNav` is rendered for real (inside a memory router), not inspected as
 * source, so a broken current state or a missing link fails here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { SectionNav } from "~/components/section-tabs";
import { createTranslator } from "~/lib/i18n";
import { activeNavPath, NAV, SECTION_TABS, sectionFor } from "~/lib/nav";

const ROOT = process.cwd();
const t = createTranslator("en");

function render(path: string): string {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(SectionNav, { t })));
}

/** The route file flat-routes maps a nav path to. */
function routeFileFor(to: string): string | null {
  const name = to.replace(/^\//, "").replaceAll("/", ".");
  const candidates = to === "/app" ? ["app._index.tsx"] : [`${name}.tsx`, `${name}._index.tsx`];
  return candidates.find((file) => existsSync(join(ROOT, "app/routes", file))) ?? null;
}

describe("activeNavPath", () => {
  it.each([
    ["/app", "/app"],
    ["/app/", "/app"],
    ["/app/surveys", "/app/surveys"],
    // Templates, Quick start and the editor are pages of Surveys.
    ["/app/surveys/library", "/app/surveys"],
    ["/app/surveys/quick-start", "/app/surveys"],
    ["/app/surveys/cm123", "/app/surveys"],
    // Channels and Survey results are the two tabs of Analytics.
    ["/app/dashboard", "/app/dashboard"],
    ["/app/results", "/app/dashboard"],
    ["/app/results/csv", "/app/dashboard"],
    // Export is a tab of Responses.
    ["/app/responses", "/app/responses"],
    ["/app/export", "/app/responses"],
    ["/app/export/csv", "/app/responses"],
    ["/app/plans", "/app/plans"],
    ["/app/settings", "/app/settings"],
    ["/app/help", "/app/help"],
  ])("%s belongs to %s", (path, expected) => {
    expect(activeNavPath(path)).toBe(expected);
  });

  it("marks nothing for a page with no item, or a lookalike path", () => {
    expect(activeNavPath("/app/privacy")).toBeNull();
    // A prefix must end at a segment boundary.
    expect(activeNavPath("/app/surveysx")).toBeNull();
    expect(activeNavPath("/app/resultsx")).toBeNull();
    expect(activeNavPath("/application")).toBeNull();
  });
});

describe("the nav list", () => {
  it("points every item, and every tab, at a route that exists", () => {
    for (const item of NAV) {
      expect(routeFileFor(item.to), `${item.to} has no route file`).not.toBeNull();
    }
    for (const tabs of Object.values(SECTION_TABS)) {
      for (const tab of tabs) expect(routeFileFor(tab.to), `${tab.to} has no route file`).not.toBeNull();
    }
  });

  it("keeps Shopify's sidebar within seven items and never repeats the home page", () => {
    const sidebar = NAV.filter((item) => item.sidebar).map((item): string => item.to);
    expect(sidebar.length).toBeLessThanOrEqual(7);
    expect(sidebar).not.toContain("/app");
  });

  it("is seven clear sections: Home, Surveys, Analytics, Responses, Plans, Settings, Help (U1)", () => {
    expect(NAV.map((item) => item.key)).toEqual([
      "nav.home",
      "nav.surveys",
      "nav.analytics",
      "nav.responses",
      "nav.plans",
      "nav.preferences",
      "nav.help",
    ]);
  });

  it("keeps templates, NPS (Survey results) and the channel report one tab away from a menu item", () => {
    const tabs = Object.values(SECTION_TABS).flatMap((list) => list.map((tab): string => tab.to));
    expect(tabs).toContain("/app/surveys/library");
    expect(tabs).toContain("/app/results");
    expect(tabs).toContain("/app/dashboard");
    expect(tabs).toContain("/app/export");
    // Every tab lights up the menu item of its own section.
    for (const [section, list] of Object.entries(SECTION_TABS)) {
      const owners = new Set(list.map((tab) => activeNavPath(tab.to)));
      expect(owners.size, `${section} tabs belong to one menu item`).toBe(1);
    }
  });
});

describe("SectionNav", () => {
  it.each(Object.entries(SECTION_TABS))("lists every page of %s on each of them", (section, tabs) => {
    for (const tab of tabs) {
      expect(sectionFor(tab.to)).toBe(section);
      const html = render(tab.to);
      for (const other of tabs) {
        expect(html).toContain(`href="${other.to}"`);
        expect(html).toContain(t(other.labelKey));
      }
      expect(html).toContain(`aria-label="${t("tabs.label")}"`);
    }
  });

  it("marks exactly the page you are on, for screen readers too", () => {
    const html = render("/app/results");
    const current = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/results"');
    expect(current[0]).toContain("st-segmented-item--current");
  });

  it("draws a small icon beside each label, never a large one above it", () => {
    const html = render("/app/surveys");
    const icons = [...html.matchAll(/<s-icon[^>]*>/g)].map((m) => m[0]);
    expect(icons).toHaveLength(SECTION_TABS.surveys.length);
    for (const icon of icons) expect(icon).toContain('size="small"');
    // Icon and label are siblings inside the same inline link.
    expect(html).toMatch(/<a [^>]*class="st-segmented-item[^"]*"[^>]*><s-icon[^>]*><\/s-icon><span>/);
  });

  it("shows nothing outside a section with several pages, nor on a detail page", () => {
    for (const path of ["/app", "/app/plans", "/app/settings", "/app/help", "/app/privacy", "/app/surveys/cm123"]) {
      expect(render(path), path).toBe("");
    }
  });
});

describe("the shell", () => {
  const shell = readFileSync(join(ROOT, "app/routes/app.tsx"), "utf8");

  it("builds Shopify's admin navigation from the list, and repeats it nowhere in the body", () => {
    expect(shell).toMatch(/<s-app-nav>[\s\S]*NAV\.filter\(\(item\) => item\.sidebar\)[\s\S]*<\/s-app-nav>/);
    // NAV is read once, for <s-app-nav>: the import and that one use.
    expect(shell.match(/\bNAV\b/g)?.length).toBe(2);
    expect(existsSync(join(ROOT, "app/components/top-nav.tsx"))).toBe(false);
    expect(shell).toMatch(/<SectionNav t=\{t\} \/>/);
  });

  it("gives the survey editor a title-bar breadcrumb back to Surveys", () => {
    expect(shell).toMatch(/<s-link slot="breadcrumb-actions" href=\{breadcrumb\.to\}>/);
    const editor = readFileSync(join(ROOT, "app/routes/app.surveys.$id.tsx"), "utf8");
    expect(editor).toMatch(/breadcrumb: \{ to: "\/app\/surveys", labelKey: "nav\.surveys" \}/);
  });

  it("is drawn by the shell alone, never again by a page", () => {
    const routes = readdirSync(join(ROOT, "app/routes")).filter((name) => name !== "app.tsx" && name.endsWith(".tsx"));
    for (const file of routes) {
      expect(readFileSync(join(ROOT, "app/routes", file), "utf8"), file).not.toMatch(/SectionNav|SectionTabs|TopNav/);
    }
  });
});

describe("client components", () => {
  // A component ships to the browser, and a `.server` module cannot. A value
  // import from one passes the typecheck and every test, then fails only the
  // production build ("Server-only module referenced by client"), which
  // `npm run check` does not run. Type-only imports are erased and are fine.
  it("import nothing but types from .server modules", () => {
    const dir = join(ROOT, "app/components");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
      const source = readFileSync(join(dir, file), "utf8");
      for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+\.server)";/gms)) {
        offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the section bar's layout", () => {
  const css = readFileSync(join(ROOT, "app/styles/app.css"), "utf8");
  const start = css.indexOf("/* --- Segmented rows");
  const block = css.slice(start, css.indexOf("/* --- Charts", start));

  it("wraps instead of scrolling sideways, so items never overlap on a phone", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/\.st-segmented \{[^}]*flex-wrap: wrap;/);
    expect(block).toMatch(/\.st-segmented \{[^}]*max-inline-size: 100%;/);
    expect(block).not.toMatch(/overflow-x|nowrap|overflow: (auto|scroll)/);
  });

  it("keeps icon and label on one line, with a 44px touch target", () => {
    expect(block).toMatch(/\.st-segmented-item \{[^}]*display: inline-flex;[^}]*align-items: center;/);
    expect(block).toMatch(/\.st-segmented-item \{[^}]*min-block-size: 2\.75rem;/);
    expect(block).not.toMatch(/flex-direction: column/);
  });

  it("takes colour only from Polaris tokens", () => {
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
