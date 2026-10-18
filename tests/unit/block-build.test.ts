import { describe, expect, it } from "vitest";

import { BLOCK_BUILD } from "../../extensions/shared/src/survey-logic";
import { CURRENT_BLOCK_BUILD, isOutdatedBlock } from "@shared/block-build";

describe("checkout block build stamp", () => {
  it("is the same in the block and the server, so a fresh deploy never reads as outdated", () => {
    expect(BLOCK_BUILD).toBe(CURRENT_BLOCK_BUILD);
    expect(isOutdatedBlock(BLOCK_BUILD)).toBe(false);
  });

  it("calls a block that sends nothing, or another build, outdated", () => {
    expect(isOutdatedBlock(null)).toBe(true);
    expect(isOutdatedBlock("2026-10-01")).toBe(true);
  });
});
