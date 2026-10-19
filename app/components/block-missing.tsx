import { Form } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { checkoutEditorUrl } from "~/lib/checkout-editor";
import type { Placement } from "@shared/survey-config";

/**
 * Says which pages the SourceTrac block has not loaded on yet, with the steps
 * to add it and a way to say it is already there.
 *
 * The app only learns the block is in place when it loads (see
 * `block-seen.server.ts`), so a block added a minute ago can still read as
 * missing. "It's already added" records it, and the editor and the Surveys list
 * both post it with `intent=block-added`.
 */
export function BlockMissingBanner({
  missing,
  shopHandle,
  heading,
  t,
}: {
  missing: readonly Placement[];
  shopHandle: string;
  /** Overrides the heading, e.g. straight after going live. */
  heading?: string;
  t: TFunction;
}) {
  const thankYouMissing = missing.includes("thank_you");
  return (
    // Missing on the Thank-you page means buyers see nothing at all; missing
    // only on the optional Order status page is a gentler note.
    <s-banner
      tone={thankYouMissing ? "warning" : "info"}
      heading={heading ?? (thankYouMissing ? t("editor.block_missing_title") : t("editor.block_order_status_title"))}
    >
      <s-stack gap="small">
        {thankYouMissing ? <s-text>{t("editor.block_missing_body")}</s-text> : null}
        {missing.includes("order_status") ? <s-text>{t("editor.block_missing_order_status_body")}</s-text> : null}
        <s-stack direction="inline" gap="small">
          <s-button href={checkoutEditorUrl(shopHandle, thankYouMissing ? "thank_you" : "order_status")} target="_top" icon="external">
            {t("editor.open_checkout_editor")}
          </s-button>
          <Form method="post">
            <input type="hidden" name="intent" value="block-added" />
            {missing.map((p) => (
              <input key={p} type="hidden" name="placement" value={p} />
            ))}
            <s-button type="submit" variant="tertiary">
              {t("editor.block_added_confirm")}
            </s-button>
          </Form>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}

/** Reads the pages posted with `intent=block-added`. */
export function postedPlacements(form: FormData): Placement[] {
  return form
    .getAll("placement")
    .map(String)
    .filter((p): p is Placement => p === "thank_you" || p === "order_status");
}
