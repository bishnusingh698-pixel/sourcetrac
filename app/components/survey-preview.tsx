import { useMemo, useState } from "react";

import {
  isChoiceType,
  isQuestionVisible,
  orderOptions,
  resolveOptions,
  SATISFACTION_OPTIONS,
  YES_NO_IDS,
  type AnswerInput,
} from "@shared/survey-rules";
import type { EditorSurvey } from "~/lib/surveys.server";

type TFn = (key: string, params?: Record<string, unknown>) => string;

/**
 * Live preview of the survey, mimicking the checkout look with neutral styles.
 *
 * It is clickable: selecting answers applies show-if logic and one-at-a-time
 * navigation, so the merchant sees exactly what a buyer will. It never submits
 * anything. Colors and fonts are intentionally neutral — the real extension
 * inherits the store's checkout branding.
 */
export function SurveyPreview({
  survey,
  languages,
  t,
}: {
  survey: EditorSurvey;
  languages: Array<{ code: string; name: string }>;
  t: TFn;
}) {
  const [answers, setAnswers] = useState<Record<string, AnswerInput>>({});
  const [step, setStep] = useState(0);
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [locale, setLocale] = useState<string>("");

  const translated = useMemo(() => {
    if (!locale) return survey;
    const tr = (survey.translations ?? {}) as Record<string, Record<string, unknown>>;
    const pack = tr[locale];
    if (!pack) return survey;
    return {
      ...survey,
      title: String(pack.title ?? survey.title),
      intro: pack.intro != null ? String(pack.intro) : survey.intro,
      buttonLabel: String(pack.buttonLabel ?? survey.buttonLabel),
      thankYouText: String(pack.thankYouText ?? survey.thankYouText),
      questions: survey.questions.map((question) => {
        const qtr = (pack.questions as Record<string, Record<string, string>>) ?? {};
        return { ...question, text: qtr[question.id]?.text ?? question.text };
      }),
    };
  }, [survey, locale]);

  const answersSoFar = useMemo(() => Object.values(answers), [answers]);
  const visible = translated.questions.filter((q) => isQuestionVisible(q, answersSoFar));
  const oneByOne = survey.layout === "one_by_one";
  const current = oneByOne ? visible[Math.min(step, Math.max(visible.length - 1, 0))] : undefined;

  const setAnswer = (questionId: string, patch: Partial<AnswerInput>) =>
    setAnswers((prev) => ({ ...prev, [questionId]: { questionId, ...prev[questionId], ...patch } }));

  const shown = oneByOne ? (current ? [current] : []) : visible;

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
        <s-text type="strong">{t("surveys.preview_title")}</s-text>
        <s-stack direction="inline" gap="small">
          <s-button type="button" onClick={() => setWidth("desktop")} variant={width === "desktop" ? "primary" : "secondary"}>
            {t("surveys.preview_desktop")}
          </s-button>
          <s-button type="button" onClick={() => setWidth("mobile")} variant={width === "mobile" ? "primary" : "secondary"}>
            {t("surveys.preview_mobile")}
          </s-button>
        </s-stack>
      </s-stack>

      {languages.length > 1 ? (
        <s-select
          label={t("surveys.preview_language")}
          value={locale}
          onChange={(e: Event) => setLocale((e.currentTarget as unknown as { value?: string }).value ?? "")}
        >
          <s-option value="">{t("surveys.preview_default_language")}</s-option>
          {languages.map((language) => (
            <s-option key={language.code} value={language.code}>
              {language.name}
            </s-option>
          ))}
        </s-select>
      ) : null}

      <s-box padding="small" border="base" borderRadius="base" background="subdued">
        <s-stack gap="base">
          <s-heading>{translated.title}</s-heading>
          {translated.intro ? <s-text color="subdued">{translated.intro}</s-text> : null}

          {oneByOne && visible.length > 1 ? (
            <s-text color="subdued" fontSize="small">
              {t("surveys.preview_progress", { current: Math.min(step + 1, visible.length), total: visible.length })}
            </s-text>
          ) : null}

          {shown.map((question) => (
            <PreviewQuestion
              key={question.id}
              question={question}
              answer={answers[question.id]}
              orderId="preview"
              onAnswer={setAnswer}
              t={t}
            />
          ))}

          <s-stack direction="inline" gap="small">
            {oneByOne && step > 0 ? (
              <s-button type="button" onClick={() => setStep((s) => Math.max(s - 1, 0))}>
                {t("surveys.preview_back")}
              </s-button>
            ) : null}
            {oneByOne && step < visible.length - 1 ? (
              <s-button type="button" variant="primary" onClick={() => setStep((s) => s + 1)}>
                {t("surveys.preview_next")}
              </s-button>
            ) : (
              <s-button type="button" variant="primary">
                {translated.buttonLabel}
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-box>

      <s-text color="subdued" fontSize="small">
        {t("surveys.preview_note")}
      </s-text>
    </s-stack>
  );
}

function PreviewQuestion({
  question,
  answer,
  orderId,
  onAnswer,
  t,
}: {
  question: EditorSurvey["questions"][number];
  answer: AnswerInput | undefined;
  orderId: string;
  onAnswer: (questionId: string, patch: Partial<AnswerInput>) => void;
  t: TFn;
}) {
  const options = orderOptions(resolveOptions(question), question.randomizeOptions ?? false, orderId);

  return (
    <s-stack gap="small">
      <s-text type="strong">{question.text || t("surveys.preview_untitled_question")}</s-text>
      {question.helpText ? (
        <s-text color="subdued" fontSize="small">
          {question.helpText}
        </s-text>
      ) : null}

      {isChoiceType(question.type) && question.type !== "satisfaction_5" ? (
        <s-choice-list
          name={question.id}
          values={answer?.optionIds ?? []}
          multiple={question.type === "multi_choice" || undefined}
          onChange={(e: Event) => {
            const target = e.currentTarget as { values?: string[] };
            onAnswer(question.id, { optionIds: target.values ?? [] });
          }}
        >
          {options.map((option) => (
            <s-choice key={option.id} value={option.id}>
              {option.label}
            </s-choice>
          ))}
        </s-choice-list>
      ) : null}

      {question.type === "satisfaction_5" ? (
        <s-choice-list
          name={question.id}
          values={answer?.optionIds ?? []}
          onChange={(e: Event) => {
            const target = e.currentTarget as { values?: string[] };
            onAnswer(question.id, { optionIds: target.values ?? [] });
          }}
        >
          {SATISFACTION_OPTIONS.map((option) => (
            <s-choice key={option.id} value={option.id}>
              {t(`surveys.satisfaction_${option.id}`)}
            </s-choice>
          ))}
        </s-choice-list>
      ) : null}

      {question.type === "yes_no" ? (
        <s-choice-list
          name={question.id}
          values={answer?.optionIds ?? []}
          onChange={(e: Event) => {
            const target = e.currentTarget as { values?: string[] };
            const id = target.values?.[0];
            onAnswer(question.id, {
              optionIds: id ? [id] : [],
              numberValue: id === YES_NO_IDS.yes ? 1 : id === YES_NO_IDS.no ? 0 : null,
            });
          }}
        >
          <s-choice value={YES_NO_IDS.yes}>{t("surveys.yes")}</s-choice>
          <s-choice value={YES_NO_IDS.no}>{t("surveys.no")}</s-choice>
        </s-choice-list>
      ) : null}

      {question.type === "rating_5" ? (
        <s-stack direction="inline" gap="small">
          {[1, 2, 3, 4, 5].map((n) => (
            <s-button
              key={n}
              type="button"
              variant={answer?.numberValue === n ? "primary" : "secondary"}
              onClick={() => onAnswer(question.id, { numberValue: n })}
              accessibilityLabel={t("surveys.rating_aria", { n })}
            >
              {String(n)}
            </s-button>
          ))}
        </s-stack>
      ) : null}

      {question.type === "nps" ? (
        <s-stack gap="small">
          <s-stack direction="inline" gap="small">
            {Array.from({ length: 11 }, (_, n) => (
              <s-button
                key={n}
                type="button"
                variant={answer?.numberValue === n ? "primary" : "secondary"}
                onClick={() => onAnswer(question.id, { numberValue: n })}
                accessibilityLabel={t("surveys.nps_aria", { n })}
              >
                {String(n)}
              </s-button>
            ))}
          </s-stack>
          <s-stack direction="inline" gap="small" justifyContent="space-between">
            <s-text color="subdued" fontSize="small">
              {t("surveys.nps_low")}
            </s-text>
            <s-text color="subdued" fontSize="small">
              {t("surveys.nps_high")}
            </s-text>
          </s-stack>
        </s-stack>
      ) : null}

      {question.type === "text" ? (
        question.textMultiline ? (
          <s-text-area
            label={question.text}
            placeholder={question.placeholder ?? undefined}
            maxLength={500}
            onInput={(e: Event) =>
              onAnswer(question.id, { textValue: (e.currentTarget as { value?: string }).value ?? "" })
            }
          />
        ) : (
          <s-text-field
            label={question.text}
            placeholder={question.placeholder ?? undefined}
            maxLength={500}
            onInput={(e: Event) =>
              onAnswer(question.id, { textValue: (e.currentTarget as { value?: string }).value ?? "" })
            }
          />
        )
      ) : null}
    </s-stack>
  );
}
