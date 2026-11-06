/**
 * Rules of the admin's visual language that a type check cannot see:
 *
 * - A selection (date range, billing cycle, template goal) is a segmented
 *   choice, never a primary button: Polaris keeps one primary action per page.
 * - Upgrade prompts are never primary buttons (Built for Shopify: no pushy or
 *   misleading upgrade prompts); they sit as plain buttons in their banner.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { RangeSwitcher, Segmented } from "~/components/admin-ui";

const ROOT = process.cwd();
const inRouter = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/app/dashboard"] }, node));

describe("Segmented choices", () => {
  it("draws a range as links with the current one marked, and no primary button", () => {
    const html = inRouter(
      createElement(RangeSwitcher, {
        label: "Date range",
        options: [
          { key: "7", label: "Last 7 days", href: "/app/dashboard?range=7", current: false },
          { key: "30", label: "Last 30 days", href: "/app/dashboard?range=30", current: true },
        ],
      }),
    );
    expect(html).not.toContain("primary");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Date range"');
    const current = [...html.matchAll(/<a[^>]*aria-current="true"[^>]*>/g)].map((m) => m[0]);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/dashboard?range=30"');
  });

  it("draws an in-page choice as pressed buttons", () => {
    const html = inRouter(
      createElement(Segmented, {
        label: "Billing cycle",
        items: [
          { key: "m", label: "Monthly", current: true, onSelect: () => undefined },
          { key: "y", label: "Yearly", current: false, onSelect: () => undefined },
        ],
      }),
    );
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("is used wherever a page used to paint the selected view as a primary button", () => {
    const library = readFileSync(join(ROOT, "app/routes/app.surveys.library._index.tsx"), "utf8");
    const plans = readFileSync(join(ROOT, "app/routes/app.plans.tsx"), "utf8");
    expect(library).not.toMatch(/variant=\{[^}]*category[^}]*"primary"/);
    expect(plans).not.toMatch(/variant=\{yearly \? "(primary|secondary)"/);
    expect(library).toContain("<Segmented");
    expect(plans).toContain("<Segmented");
  });
});

describe("upgrade prompts", () => {
  it("are never primary buttons", () => {
    for (const file of ["app/routes/app.tsx", "app/components/channel-report.tsx"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(/<s-button href="\/app\/plans" variant="primary"/);
    }
  });
});

describe("icons", () => {
  it("are all drawn at one size", () => {
    const files = [
      ...readdirSync(join(ROOT, "app/components")).map((f) => `app/components/${f}`),
      ...readdirSync(join(ROOT, "app/routes")).map((f) => `app/routes/${f}`),
    ].filter((f) => f.endsWith(".tsx"));
    const unsized: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(/<s-icon\b[^>]*>/g)) {
        if (!/size="small"/.test(match[0])) unsized.push(`${file}: ${match[0]}`);
      }
    }
    expect(unsized).toEqual([]);
  });
});
