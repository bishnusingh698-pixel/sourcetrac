/**
 * Going live sends the merchant to add the block, and "live" is never claimed
 * for a page the block has not loaded on.
 *
 * The editor used to say "Your survey is live" as soon as it was turned on,
 * though buyers see nothing until the SourceTrac block is added in Shopify's
 * checkout editor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkoutEditorUrl, placementsMissingBlock } from "~/lib/checkout-editor";

const read = (relative: string) => readFileSync(join(__dirname, "../..", relative), "utf8");

describe("checkout editor link", () => {
  it("opens the checkout editor, on the Thank-you page when that is the page", () => {
    expect(checkoutEditorUrl("demo")).toBe("https://admin.shopify.com/store/demo/settings/checkout/editor?page=thank-you");
    expect(checkoutEditorUrl("demo", "order_status")).toBe("https://admin.shopify.com/store/demo/settings/checkout/editor");
  });

  it("sits next to the steps for adding the block wherever it appears", () => {
    // Shopify has no link that opens the editor with the block placed, so the
    // merchant must be told which page to pick and to add it.
    expect(read("app/components/block-missing.tsx")).toContain('t("editor.block_missing_body")');
    expect(read("app/components/block-missing.tsx")).toContain('t("editor.block_missing_order_status_body")');
    expect(read("app/routes/app.surveys.$id.tsx")).toContain('t("editor.store_step_block")');
    expect(read("app/routes/app.surveys.$id.tsx")).toContain('t("editor.store_step_order_status")');
    expect(read("app/routes/app._index.tsx")).toContain('t("onboarding.step2_body")');
  });
});

describe("pages missing the block", () => {
  it("lists only checkout pages the block has never loaded on", () => {
    expect(placementsMissingBlock(["thank_you", "order_status"], { thank_you: true, order_status: false })).toEqual([
      "order_status",
    ]);
    expect(placementsMissingBlock(["thank_you"], { thank_you: true })).toEqual([]);
    expect(placementsMissingBlock(["onsite", "link"], {})).toEqual([]);
  });
});

describe("survey editor", () => {
  const source = read("app/routes/app.surveys.$id.tsx");

  it("asks to open the checkout editor after every way of turning a survey on or publishing it", () => {
    expect(source.match(/\?launched=1&\$\{OPEN_CHECKOUT\}=1/g)).toHaveLength(2);
    expect(source.match(/\?published=1&\$\{OPEN_CHECKOUT\}=1/g)).toHaveLength(2);
    expect(source).not.toMatch(/\?(launched|published)=1`/);
  });

  it("opens it at the top level, only while a page is missing the block", () => {
    expect(source).toContain('params.get(OPEN_CHECKOUT) === "1" && missing.length > 0');
    expect(source).toContain('window.open(editorHref, "_top")');
  });

  it("does not call the survey live on a page without the block", () => {
    expect(source).toContain("placementsMissingBlock(survey.placements, data.blockSeen)");
    expect(source).toContain('t("editor.status_on_no_block")');
    expect(source).toContain("t(`editor.notice_${notice}_no_block`)");
  });
});
