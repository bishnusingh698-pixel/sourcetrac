import { Form } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { checkoutEditorUrl } from "~/lib/checkout-editor";
import type { Placement } from "@shared/survey-config";

/**
 * Says which pages the SourceTrac block has not loaded on yet, with the way to
 * add it and a way to say it is already there.
 *
 * The app only learns the block is in place when it loads (see
 * `block-seen.server.ts`), so a block added a minute ago can still read as
 * missing. "It's added" records it, and the editor and the Surveys list both
 * post it with `intent=block-added`.
 */
export function BlockMissingBanner({
  missing,
  anySeen,
  shopHandle,
  heading,
  t,
}: {
  missing: readonly Placement[];
  /** True when the block has loaded on at least one of the survey's pages. */
  anySeen: boolean;
  shopHandle: string;
  /** Overrides the heading, e.g. straight after going live. */
  heading?: string;
  t: TFunction;
}) {
  const places = missing.map((p) => t(`editor.placement_${p}`)).join(", ");
  return (
    <s-banner
      tone={anySeen ? "info" : "warning"}
      heading={heading ?? (anySeen ? t("editor.block_partial_title", { places }) : t("editor.block_missing_title"))}
    >
      <s-stack gap="small">
        <s-text>{t("editor.block_missing_body", { places })}</s-text>
        <s-stack direction="inline" gap="small">
          <s-button href={checkoutEditorUrl(shopHandle, missing[0])} target="_top" icon="external">
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
