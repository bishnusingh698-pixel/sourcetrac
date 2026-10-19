import { Form } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { checkoutEditorUrl } from "~/lib/checkout-editor";

/**
 * Says the SourceTrac block has not loaded on the Thank-you page yet, with the
 * steps to add it and a way to say it is already there.
 *
 * The app only learns the block is in place when it loads (see
 * `block-seen.server.ts`), so a block added a minute ago can still read as
 * missing. "It's added" records it, and the editor and the Surveys list both
 * post it with `intent=block-added`.
 */
export function BlockMissingBanner({
  shopHandle,
  heading,
  t,
}: {
  shopHandle: string;
  /** Overrides the heading, e.g. straight after going live. */
  heading?: string;
  t: TFunction;
}) {
  return (
    <s-banner tone="warning" heading={heading ?? t("editor.block_missing_title")}>
      <s-stack gap="small">
        <s-text>{t("editor.block_missing_body")}</s-text>
        <s-stack direction="inline" gap="small">
          <s-button href={checkoutEditorUrl(shopHandle)} target="_top" icon="external">
            {t("editor.open_checkout_editor")}
          </s-button>
          <Form method="post">
            <input type="hidden" name="intent" value="block-added" />
            <input type="hidden" name="placement" value="thank_you" />
            <s-button type="submit" variant="tertiary">
              {t("editor.block_added_confirm")}
            </s-button>
          </Form>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
