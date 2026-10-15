/**
 * A survey's ID, with a copy button, for the checkout block's "Survey ID"
 * setting.
 *
 * With several surveys a merchant could not tell which one a block would show.
 * Pasting this ID into a block pins that block to this survey, and the checkout
 * editor then previews this exact survey. The ID is shown as selectable text
 * too, because the clipboard can be blocked inside the admin frame.
 */

type TFn = (key: string, params?: Record<string, unknown>) => string;

export function SurveyIdBox({ surveyId, t }: { surveyId: string; t: TFn }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(surveyId);
      window.shopify?.toast?.show(t("editor.survey_id_copied"));
    } catch {
      window.shopify?.toast?.show(t("editor.survey_id_copy_failed"), { isError: true });
    }
  };

  return (
    <s-stack gap="small-200">
      <s-text type="strong">{t("editor.survey_id_label")}</s-text>
      <s-box padding="small" border="base" borderRadius="base" background="subdued">
        <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
          <div className="st-wrap-anywhere">
            <s-text fontVariantNumeric="tabular-nums">{surveyId}</s-text>
          </div>
          <s-button type="button" variant="tertiary" icon="clipboard" onClick={copy}>
            {t("support.copy")}
          </s-button>
        </s-grid>
      </s-box>
      <s-text color="subdued" fontSize="small">
        {t("editor.survey_id_help")}
      </s-text>
    </s-stack>
  );
}
