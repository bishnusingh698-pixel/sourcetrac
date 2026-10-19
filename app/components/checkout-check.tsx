import type { TFn } from "~/components/survey-editor";
import { checkoutEditorUrl } from "~/lib/checkout-editor";

/**
 * "Checkout check" on the Surveys page: one line per thing that has to be true
 * for buyers to see a survey, page by page, green or with what to do next.
 * Built from `runCheckoutCheck`; times are formatted on the server.
 */

export type CheckoutCheckView = {
  pages: Array<{
    placement: "thank_you" | "order_status";
    survey: { name: string; audienceRules: boolean } | null;
    block: { kind: "buyer" | "placed"; when: string } | { kind: "never" };
  }>;
  planHidden: number;
};

type Line = { ok: boolean | null; text: string; action?: { href: string; label: string } };

function Row({ line }: { line: Line }) {
  const icon = line.ok === true ? "check-circle" : line.ok === false ? "alert-circle" : "info";
  const tone = line.ok === true ? "success" : line.ok === false ? "critical" : "info";
  return (
    <s-grid gridTemplateColumns="auto minmax(0, 1fr)" gap="small" alignItems="start">
      <s-icon type={icon} tone={tone} />
      <s-stack gap="small-200">
        <s-text>{line.text}</s-text>
        {line.action ? (
          <div>
            <s-button href={line.action.href} target="_top" variant="secondary" icon="external">
              {line.action.label}
            </s-button>
          </div>
        ) : null}
      </s-stack>
    </s-grid>
  );
}

export function CheckoutCheck({ check, shopHandle, t }: { check: CheckoutCheckView; shopHandle: string; t: TFn }) {
  const lines: Line[] = [];
  for (const page of check.pages) {
    const pageName = t(`surveys.placement_${page.placement}`);
    const editor = { href: checkoutEditorUrl(shopHandle, page.placement), label: t("editor.open_checkout_editor") };
    lines.push(
      page.survey
        ? {
            ok: true,
            text: t(page.survey.audienceRules ? "surveys.check_survey_rules" : "surveys.check_survey", {
              page: pageName,
              survey: page.survey.name,
            }),
          }
        : // Nothing live is the merchant's own choice on the optional page.
          { ok: page.placement === "thank_you" ? false : null, text: t("surveys.check_no_survey", { page: pageName }) },
    );
    lines.push(
      page.block.kind === "buyer"
        ? { ok: true, text: t("surveys.check_block_buyer", { page: pageName, when: page.block.when }) }
        : page.block.kind === "placed"
          ? { ok: null, text: t("surveys.check_block_placed", { page: pageName, when: page.block.when }) }
          : {
              ok: false,
              text: t(page.placement === "thank_you" ? "surveys.check_block_never" : "surveys.check_block_never_order_status"),
              action: editor,
            },
    );
  }
  if (check.planHidden > 0) {
    lines.push({ ok: false, text: t("surveys.check_plan_hidden", { count: check.planHidden }) });
  }
  lines.push({ ok: null, text: t("surveys.check_new_order") });

  return (
    <s-section heading={t("surveys.check_title")}>
      <s-stack gap="small">
        {lines.map((line, index) => (
          <Row key={index} line={line} />
        ))}
      </s-stack>
    </s-section>
  );
}
