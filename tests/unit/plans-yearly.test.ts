/**
 * Yearly billing can be bought from every paid plan card.
 *
 * The Monthly / Yearly switch used to be the only way in, as two links to
 * `?cycle=`, and a merchant reported they could not buy yearly at all. Each
 * paid card now posts both cycles, and the switch is local state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/routes/app.plans.tsx"), "utf8");

describe("Plans page", () => {
  it("offers the other billing cycle as its own button on each paid card", () => {
    expect(source).toContain("cycle={otherCycle}");
    expect(source).toContain('t("plans.choose_plan_yearly_instead"');
    expect(source).toContain('<input type="hidden" name="cycle" value={cycle} />');
  });

  it("switches cycle without depending on a link", () => {
    expect(source).not.toContain('href="/app/plans?cycle=');
    expect(source).toContain('onClick={() => setCycle("yearly")}');
  });
});
