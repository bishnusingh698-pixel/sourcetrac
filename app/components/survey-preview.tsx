import { describeFollowUp, type FollowUp } from "@shared/survey-summary";
import { resolveOptions, SATISFACTION_OPTIONS, YES_NO_IDS } from "@shared/survey-rules";
import type { EditorSurvey } from "~/lib/surveys.server";

type TFn = (key: string, params?: Record<string, unknown>) => string;

/**
 * What buyers see, drawn as a still picture.
 *
 * The old preview was an interactive copy of the checkout block, with device,
 * page and language switches. It disagreed with the real block often enough
 * that merchants stopped trusting it. This one shows every question at once,
 * follow-ups included and labelled with when they appear, so the whole survey
 * can be checked at a glance on any screen. It has no state and nothing to
 * click, so there is nothing in it that can stop working.
 *
 * The real survey takes its fonts and colours from the store's checkout, which
 * the caption says.
 */
export function SurveyPreview({ survey, t }: { survey: EditorSurvey; t: TFn }) {
  const questions = survey.questions;

  return (
    <s-stack gap="small">
      <div className="st-preview" role="group" aria-label={t("preview.aria")}>
        <s-stack gap="base">
          {survey.design.showTitle && survey.title ? <s-text type="strong">{survey.title}</s-text> : null}
          {survey.intro ? <s-text color="subdued">{survey.intro}</s-text> : null}

          {questions.length === 0 ? <s-text color="subdued">{t("preview.empty")}</s-text> : null}

          {questions.map((question, index) => {
            const followUp = describeFollowUp(question, questions);
            return (
              <div key={question.id || index} className={followUp ? "st-preview-q st-preview-follow" : "st-preview-q"}>
                <s-stack gap="small-200">
                  {followUp ? (
                    <s-text color="subdued" fontSize="small">
                      {followUpText(followUp, t)}
                    </s-text>
                  ) : null}
                  <s-text type="strong">
                    {question.text || t("preview.untitled")}
                    {question.required ? " *" : ""}
                  </s-text>
                  {question.helpText ? (
                    <s-text color="subdued" fontSize="small">
                      {question.helpText}
                    </s-text>
                  ) : null}
                  <Answers question={question} design={survey.design} t={t} />
                </s-stack>
              </div>
            );
          })}

          {questions.length > 0 ? (
            <span className="st-preview-button">{survey.buttonLabel || t("preview.button")}</span>
          ) : null}
        </s-stack>
      </div>
      <s-text color="subdued" fontSize="small">
        {survey.layout === "one_by_one" ? `${t("preview.one_by_one")} ` : ""}
        {t("preview.caption")}
      </s-text>
    </s-stack>
  );
}

function followUpText(followUp: FollowUp, t: TFn): string {
  if (followUp.parentNumber === 0) return t("preview.follow_up_unknown");
  const labels = followUp.options.map((o) =>
    o.label ?? (o.id === YES_NO_IDS.yes ? t("surveys.yes") : o.id === YES_NO_IDS.no ? t("surveys.no") : t(`surveys.satisfaction_${o.id}`)),
  );
  if (labels.length > 0) {
    const shown = labels.slice(0, 3).map((l) => `“${l}”`).join(", ");
    const extra = labels.length > 3 ? ` +${labels.length - 3}` : "";
    return t("preview.follow_up_answers", { n: followUp.parentNumber, answers: `${shown}${extra}` });
  }
  if (followUp.min !== null || followUp.max !== null) {
    return t("preview.follow_up_range", { n: followUp.parentNumber, min: followUp.min ?? "…", max: followUp.max ?? "…" });
  }
  return t("preview.follow_up_unknown");
}

function Answers({ question, design, t }: { question: EditorSurvey["questions"][number]; design: EditorSurvey["design"]; t: TFn }) {
  switch (question.type) {
    case "single_choice":
    case "multi_choice": {
      const marker = question.type === "multi_choice" ? "st-box" : "st-dot";
      const options = resolveOptions(question).filter((o) => !o.isOther);
      return (
        <ul className="st-preview-options">
          {options.map((option) => (
            <li key={option.id}>
              <span className={marker} aria-hidden="true" />
              {option.label}
            </li>
          ))}
          {question.allowOther || question.options.some((o) => o.isOther) ? (
            <li>
              <span className={marker} aria-hidden="true" />
              {t("preview.other")}
            </li>
          ) : null}
        </ul>
      );
    }
    case "dropdown":
      return <span className="st-preview-field">{t("preview.dropdown")}</span>;
    case "yes_no":
      return (
        <ul className="st-preview-options">
          <li>
            <span className="st-dot" aria-hidden="true" />
            {t("surveys.yes")}
          </li>
          <li>
            <span className="st-dot" aria-hidden="true" />
            {t("surveys.no")}
          </li>
        </ul>
      );
    case "satisfaction_5":
      return (
        <ul className="st-preview-options">
          {SATISFACTION_OPTIONS.map((option) => (
            <li key={option.id}>
              <span className="st-dot" aria-hidden="true" />
              {t(`surveys.satisfaction_${option.id}`)}
            </li>
          ))}
        </ul>
      );
    case "rating_5":
      return (
        <Scale
          values={[1, 2, 3, 4, 5]}
          stars={design.ratingStyle === "stars"}
          low={design.scaleLowLabel}
          high={design.scaleHighLabel}
        />
      );
    case "nps":
      return (
        <Scale
          values={Array.from({ length: 11 }, (_, n) => n)}
          low={design.scaleLowLabel || t("surveys.nps_low")}
          high={design.scaleHighLabel || t("surveys.nps_high")}
        />
      );
    default:
      return (
        <span className={question.textMultiline ? "st-preview-field st-preview-area" : "st-preview-field"}>
          {question.placeholder ?? ""}
        </span>
      );
  }
}

function Scale({ values, stars = false, low, high }: { values: number[]; stars?: boolean; low?: string; high?: string }) {
  return (
    <s-stack gap="small-200">
      <div className="st-preview-scale">
        {values.map((n) => (
          <span key={n}>{stars ? "★" : n}</span>
        ))}
      </div>
      {low || high ? (
        <s-grid gridTemplateColumns="minmax(0, 1fr) minmax(0, 1fr)" gap="small">
          <s-text color="subdued" fontSize="small">
            {low ?? ""}
          </s-text>
          <s-text color="subdued" fontSize="small">
            <span className="st-align-end">{high ?? ""}</span>
          </s-text>
        </s-grid>
      ) : null}
    </s-stack>
  );
}
