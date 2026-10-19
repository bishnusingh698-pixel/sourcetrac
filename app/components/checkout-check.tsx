import type { TFn } from "~/components/survey-editor";
import { checkoutEditorUrl } from "~/lib/checkout-editor";

/**
 * "Checkout check" on the Surveys page: one line per thing that has to be true
 * for buyers to see a survey, green or with what to do next. Built from
 * `runCheckoutCheck`; times are formatted on the server.
 */

export type CheckoutCheckView = {
  commit: string | null;
  databaseOk: boolean;
  databaseCode: string | null;
  planHidden: number;
  pages: Array<{
    placement: "thank_you" | "order_status";
    survey: { name: string; audienceRules: boolean } | null;
    block: { when: string; outdated: boolean; where: "buyer" | "editor" } | null;
  }>;
};

type Line = { ok: boolean | null; text: string; action?: { href: string; label: string } };

function Row({ line }: { line: Line }) {
  const icon = line.ok === true ? "check-circle" : line.ok === false ? "alert-circle" : "info";
  const tone = line.ok === true ? "success" : line.ok === false ? "critical" : "info";
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-icon type={icon} tone={tone} />
      <s-text>{line.text}</s-text>
      {line.action ? (
        <s-button href={line.action.href} target="_top" variant="tertiary" icon="external">
          {line.action.label}
        </s-button>
      ) : null}
    </s-stack>
  );
}

export function CheckoutCheck({ check, shopHandle, t }: { check: CheckoutCheckView; shopHandle: string; t: TFn }) {
  const lines: Line[] = [
    {
      ok: true,
      text: check.commit ? t("surveys.check_server_version", { commit: check.commit }) : t("surveys.check_server"),
    },
    check.databaseOk
      ? { ok: true, text: t("surveys.check_database_ok") }
      : { ok: false, text: t("surveys.check_database_fail", { code: check.databaseCode ?? "" }) },
  ];

  for (const page of check.pages) {
    const pageName = t(`surveys.placement_${page.placement}`);
    // The Order status page only matters when something is meant to be there.
    if (page.placement === "order_status" && !page.survey && !page.block) continue;
    lines.push(
      page.survey
        ? {
            ok: true,
            text: t(page.survey.audienceRules ? "surveys.check_survey_rules" : "surveys.check_survey", {
              page: pageName,
              survey: page.survey.name,
            }),
          }
        : { ok: false, text: t("surveys.check_no_survey", { page: pageName }) },
    );
    const editor = { href: checkoutEditorUrl(shopHandle, page.placement), label: t("editor.open_checkout_editor") };
    lines.push(
      !page.block
        ? { ok: false, text: t("surveys.check_block_never", { page: pageName }), action: editor }
        : page.block.outdated
          ? { ok: false, text: t("surveys.check_block_old", { page: pageName, when: page.block.when }) }
          : {
              ok: true,
              text: t(page.block.where === "editor" ? "surveys.check_block_editor" : "surveys.check_block_buyer", {
                page: pageName,
                when: page.block.when,
              }),
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
