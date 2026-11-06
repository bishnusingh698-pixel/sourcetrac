/**
 * The Plans page as a merchant sees it in each trial state, rendered for real
 * in a data router (happy-dom). Shopify's own approval page also shows the
 * trial, but the app must say it first, factually: length, end date, the
 * price after it, and that cancelling before then costs nothing.
 */
import "../helpers/dom-globals";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import Plans from "~/routes/app.plans";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const plan = (key: "free" | "growth" | "scale", monthly: string | null, yearly: string | null) => ({
  key,
  monthly,
  yearly,
  yearlyPerMonth: yearly,
  yearlySaving: yearly,
  features: [],
});

function data(overrides: Record<string, unknown>) {
  return {
    activePlan: "free",
    trial: { offerDays: 14, fullDays: 14, endsOn: null, priceAfter: null, wouldEndOn: "November 20, 2026" },
    scheduledOn: null,
    synced: false,
    used: 3,
    cap: { cap: 50, used: 3, warningAt: 40, atWarning: false, atCap: false, exceeded: false, shouldFlag: false },
    activeCycle: null,
    scheduled: null,
    cycle: "monthly",
    discountPercent: 10,
    maxYearlySaving: "$11.99",
    plans: [plan("free", null, null), plan("growth", "$4.99", "$53.89"), plan("scale", "$9.99", "$107.89")],
    ...overrides,
  };
}

async function render(loaderData: Record<string, unknown>): Promise<string> {
  const router = createMemoryRouter([{ path: "/app/plans", Component: Plans, loader: () => loaderData }], {
    initialEntries: ["/app/plans"],
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(RouterProvider, { router })));
  return container.innerHTML;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Plans page and the free trial", () => {
  it("offers the trial before approval: length, end date and the price after", async () => {
    const html = await render(data({}));
    expect(html).toContain("14-day free trial");
    expect(html).toContain("Free until November 20, 2026, then $4.99 a month.");
    expect(html).toContain("Start free trial of Growth");
    expect(html).toContain("Growth and Scale start with a 14-day free trial, once per store.");
  });

  it("says when a running trial ends, what it then costs, and that cancelling before is free", async () => {
    const html = await render(
      data({
        activePlan: "growth",
        activeCycle: "monthly",
        cap: { cap: null, used: 3, warningAt: null, atWarning: false, atCap: false, exceeded: false, shouldFlag: false },
        trial: { offerDays: 9, fullDays: 14, endsOn: "November 15, 2026", priceAfter: "$4.99", wouldEndOn: "November 15, 2026" },
      }),
    );
    expect(html).toContain("Your free trial ends on November 15, 2026");
    expect(html).toContain("After that, Growth costs $4.99 a month, billed on your Shopify invoice. Cancel before November 15, 2026 and you won");
    // Switching keeps the days left; it never offers a fresh 14 days.
    expect(html).toContain("Your free trial carries over: 9 days left.");
    expect(html).not.toContain("Start free trial");
  });

  it("offers no trial once the store has used it", async () => {
    const html = await render(data({ trial: { offerDays: 0, fullDays: 14, endsOn: null, priceAfter: null, wouldEndOn: null } }));
    expect(html).not.toContain("day free trial</");
    expect(html).not.toContain("Free until");
    expect(html).toContain("Choose Growth");
    expect(html).not.toContain("once per store");
  });
});
