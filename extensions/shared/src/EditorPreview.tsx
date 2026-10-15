/** @jsxImportSource preact */
import { MultiSurveyPreview, MultiSurveyView } from "./MultiSurveyView";
import type { useMultiSurvey } from "./use-multi-survey";

type SurveyState = ReturnType<typeof useMultiSurvey>;

/**
 * What a block shows inside Shopify's checkout editor.
 *
 * The merchant's real survey, loaded by the block's "Survey ID" setting (or the
 * highest-priority live survey without one), with a line saying which survey it
 * is and whether buyers will see it. The merchant can click through it; nothing
 * is sent. When the survey cannot be loaded the old sample is shown with a line
 * saying why, so the block never looks broken in the editor.
 */
export function EditorPreview({ survey }: { survey: SurveyState }) {
  const { t, previewInfo } = survey;

  if (survey.phase === "loading") {
    return (
      <s-text color="subdued" type="small">
        {t("sourcetrac.loading", "Loading…")}
      </s-text>
    );
  }

  if (!survey.survey) {
    const why =
      previewInfo?.reason === "not_found"
        ? t("sourcetrac.editorNotFound", "No survey has this ID. Copy the ID again from the survey in SourceTrac.")
        : previewInfo?.reason === "none_live"
          ? t("sourcetrac.editorNoneLive", "No survey is live on this page yet. Buyers see nothing here until a survey goes live in SourceTrac.")
          : t(
              "sourcetrac.editorUnavailable",
              "Your survey could not be loaded in the editor, so this is a sample. Buyers still see the survey you set in SourceTrac.",
            );
    return (
      <s-stack gap="small-200">
        <s-banner tone="warning">{why}</s-banner>
        <MultiSurveyPreview t={t} />
      </s-stack>
    );
  }

  const name = previewInfo?.name ?? "";
  const status =
    previewInfo?.status === "draft"
      ? t("sourcetrac.editorDraft", "Draft. Buyers won't see it until you go live in SourceTrac.")
      : previewInfo?.status === "paused"
        ? t("sourcetrac.editorPaused", "Paused. Buyers won't see it until you resume it in SourceTrac.")
        : null;
  const otherPage =
    previewInfo?.onThisPage === false
      ? t(
          "sourcetrac.editorOtherPage",
          "This survey is not set to show on this page. Turn this page on under \"Where it shows\" in SourceTrac.",
        )
      : null;

  return (
    <s-stack gap="small-200">
      <s-text color="subdued" type="small">
        {t("sourcetrac.editorShowing", "SourceTrac survey: {{name}}").replace("{{name}}", name)}
      </s-text>
      {status ? <s-banner tone="warning">{status}</s-banner> : null}
      {otherPage ? <s-banner tone="warning">{otherPage}</s-banner> : null}
      <MultiSurveyView
        phase={survey.phase === "hidden" ? "asking" : survey.phase}
        title={survey.survey.title}
        intro={survey.survey.intro}
        buttonLabel={survey.survey.buttonLabel}
        thankYouText={survey.survey.thankYouText}
        questions={survey.shown}
        answers={survey.answers}
        oneByOne={survey.oneByOne}
        step={survey.step}
        total={survey.total}
        complete={survey.complete}
        onAnswer={survey.setAnswer}
        onNext={survey.next}
        onBack={survey.back}
        onSubmit={survey.submit}
        busy={survey.busy}
        t={t}
      />
      <s-text color="subdued" type="small">
        {previewInfo?.pinned
          ? t("sourcetrac.editorPinnedNote", "Preview. Nothing is sent from the editor. Targeting rules apply on real orders.")
          : t(
              "sourcetrac.editorPriorityNote",
              "Preview. This block shows your highest-priority live survey. To choose one, paste its Survey ID into this block's settings.",
            )}
      </s-text>
    </s-stack>
  );
}
