import type { TFn } from "~/components/survey-editor";
import { checkoutEditorUrl } from "~/lib/checkout-editor";

/**
 * "Checkout check" on the Surveys page: one line per thing that has to be true
 * for buyers to see a survey on the Thank-you page, green or with what to do
 * next. Built from `runCheckoutCheck`; times are formatted on the server.
 */

export type CheckoutCheckView = {
  survey: { name: string; audienceRules: boolean } | null;
  block: { kind: "buyer" | "placed"; when: string } | { kind: "never" };
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
  const editor = { href: checkoutEditorUrl(shopHandle), label: t("editor.open_checkout_editor") };
  const lines: Line[] = [
    check.survey
      ? {
          ok: true,
          text: t(check.survey.audienceRules ? "surveys.check_survey_rules" : "surveys.check_survey", {
            survey: check.survey.name,
          }),
        }
      : { ok: false, text: t("surveys.check_no_survey") },
    check.block.kind === "buyer"
      ? { ok: true, text: t("surveys.check_block_buyer", { when: check.block.when }) }
      : check.block.kind === "placed"
        ? { ok: null, text: t("surveys.check_block_placed", { when: check.block.when }) }
        : { ok: false, text: t("surveys.check_block_never"), action: editor },
  ];
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
