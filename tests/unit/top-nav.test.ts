/**
 * The in-app top bar: every page is reachable, the current one is marked, and
 * Shopify's sidebar stays inside its limits.
 *
 * `TopNav` is rendered for real (inside a memory router), not inspected as
 * source, so a broken active state or a missing link fails here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { TopNav } from "~/components/top-nav";
import { createTranslator } from "~/lib/i18n";
import { activeNavPath, NAV } from "~/lib/nav";

const ROOT = process.cwd();
const t = createTranslator("en");

function render(path: string): string {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(TopNav, { t })));
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
    ["/app/surveys/library", "/app/surveys"],
    ["/app/surveys/cm123", "/app/surveys"],
    ["/app/results", "/app/results"],
    ["/app/dashboard", "/app/dashboard"],
    ["/app/responses", "/app/responses"],
    ["/app/export", "/app/export"],
    ["/app/export/csv", "/app/export"],
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
    expect(activeNavPath("/application")).toBeNull();
  });
});

describe("the nav list", () => {
  it("points every item at a route that exists", () => {
    for (const item of NAV) {
      expect(routeFileFor(item.to), `${item.to} has no route file`).not.toBeNull();
    }
  });

  it("keeps Shopify's sidebar within seven items and never repeats the home page", () => {
    const sidebar = NAV.filter((item) => item.sidebar).map((item): string => item.to);
    expect(sidebar.length).toBeLessThanOrEqual(7);
    expect(sidebar).not.toContain("/app");
  });

  it("puts NPS (Results) and the channel report one tap away", () => {
    const paths = NAV.map((item) => item.to);
    expect(paths).toContain("/app/results");
    expect(paths).toContain("/app/dashboard");
    expect(paths[0]).toBe("/app");
  });
});

describe("TopNav", () => {
  it("renders a link to every page with its translated label", () => {
    const html = render("/app");
    for (const item of NAV) {
      expect(html).toContain(`href="${item.to}"`);
      expect(html).toContain(t(item.key));
    }
    expect(html).toContain(`aria-label="${t("nav.label")}"`);
  });

  it("marks exactly one item as the current page, and says so to screen readers", () => {
    const html = render("/app/surveys/library");
    const current = [...html.matchAll(/<s-clickable[^>]*data-current="true"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/surveys"');
    expect(html.split(t("nav.current")).length - 1).toBe(1);
  });

  it("marks nothing on a page outside the menu", () => {
    expect(render("/app/privacy")).not.toContain('data-current="true"');
  });
});

describe("the shell", () => {
  const shell = readFileSync(join(ROOT, "app/routes/app.tsx"), "utf8");

  it("renders the top bar on every page", () => {
    expect(shell).toMatch(/import \{ TopNav \} from "~\/components\/top-nav"/);
    expect(shell).toMatch(/<TopNav t=\{t\} \/>/);
  });

  it("builds Shopify's sidebar from the same list", () => {
    expect(shell).toMatch(/NAV\.filter\(\(item\) => item\.sidebar\)/);
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

describe("the menu's layout", () => {
  const css = readFileSync(join(ROOT, "app/styles/app.css"), "utf8");
  const start = css.indexOf("/* --- Top navigation");
  const block = css.slice(start, css.indexOf("/* --- Charts", start));

  it("never scrolls sideways", () => {
    expect(block).not.toMatch(/overflow-x|nowrap/);
  });

  it("fills its rows evenly at every width, with no lone tile on the last row", () => {
    const columns = [...block.matchAll(/repeat\((\d+), minmax\(0, 1fr\)\)/g)].map((m) => Number(m[1]));
    expect(columns.length).toBeGreaterThanOrEqual(2);
    for (const cols of columns) {
      const lastRow = NAV.length % cols;
      expect(lastRow === 0 || lastRow >= cols - 1, `${cols} columns leave ${lastRow} on the last row`).toBe(true);
    }
  });

  it("puts each label under its icon inside its own tile", () => {
    const html = render("/app");
    expect(html.match(/class="st-topnav-tile"/g)).toHaveLength(NAV.length);
    // Each link is a flex item of its own cell, so the rows cannot overlap,
    // without overriding Polaris's own display on the element.
    expect(block).toMatch(/\.st-topnav-cell \{\s*display: flex;/);
    expect(block).not.toMatch(/s-clickable \{[^}]*display:/);
  });
});
