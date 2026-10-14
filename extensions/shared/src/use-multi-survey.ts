import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  log,
  OTHER_CHANNEL,
  type AnswerInput,
  type CompiledOption,
  type CompiledQuestion,
  type CompiledSurvey,
  type Placement,
  type SubmitResult,
  type SurveyConfigV2,
} from "./survey-logic";

export type MultiPhase = "loading" | "asking" | "sending" | "done" | "hidden";

/** How long the confirmation stays visible before the block collapses. */
const CONFIRMATION_MS = 2500;

export interface MultiSurveyApi {
  fetchSurvey: (orderId: string, placement: Placement, locale: string | null) => Promise<SurveyConfigV2 | null>;
  submitAnswers: (params: {
    surveyId: string;
    orderId: string | null;
    placement: Placement;
    answers: AnswerInput[];
  }) => Promise<SubmitResult | null>;
  /** The buyer's language (e.g. "de"), for language targeting and translation. */
  getLocale?: () => string | null;
  t: (key: string, fallback: string) => string;
}

/** An answer the buyer has given, keyed by question id. */
export type AnswerState = Record<string, AnswerInput>;

/**
 * A question is visible when its show-if condition is met by the answers so far.
 * Mirrors `isQuestionVisible` in shared/survey-rules.ts, reimplemented here
 * because the extension bundle cannot import the app's `@shared` alias.
 */
export function questionVisible(question: CompiledQuestion, answers: AnswerState): boolean {
  const cond = question.showIf;
  if (!cond) return true;
  const answer = answers[cond.questionId];
  if (!answer) return false;

  if (cond.optionIds && cond.optionIds.length > 0) {
    const selected = answer.optionIds ?? [];
    return selected.some((id) => cond.optionIds?.includes(id));
  }
  if (typeof cond.min === "number" || typeof cond.max === "number") {
    const value = answer.numberValue;
    if (typeof value !== "number") return false;
    if (typeof cond.min === "number" && value < cond.min) return false;
    if (typeof cond.max === "number" && value > cond.max) return false;
    return true;
  }
  return false;
}

/** The options to render, including the synthetic "Other" when free text is on. */
export function optionsFor(question: CompiledQuestion, otherLabel: string): CompiledOption[] {
  const base = question.options;
  if (!question.allowOther || base.some((o) => o.isOther || o.id === OTHER_CHANNEL)) return base;
  return [...base, { id: OTHER_CHANNEL, label: otherLabel, isOther: true }];
}

/**
 * Overlay the buyer's language onto a compiled survey.
 *
 * The merchant authors per-language text in the Studio (`Survey.translations`),
 * which the compiler ships in the config, but nothing used to apply it: every
 * buyer read the survey in the merchant's default language regardless of their
 * own. Falls back to the default text for any string a locale does not define.
 * Mirrors `survey-preview.tsx`, which does the same for the admin preview.
 */
export function localizeSurvey(survey: CompiledSurvey, locale: string | null): CompiledSurvey {
  if (!locale) return survey;
  const packs = (survey.translations ?? {}) as Record<string, Record<string, unknown>>;
  const pack = packs[locale];
  if (!pack) return survey;

  const questions = (pack.questions as Record<string, Record<string, string>> | undefined) ?? {};
  return {
    ...survey,
    title: typeof pack.title === "string" ? pack.title : survey.title,
    intro: pack.intro != null ? String(pack.intro) : survey.intro,
    buttonLabel: typeof pack.buttonLabel === "string" ? pack.buttonLabel : survey.buttonLabel,
    thankYouText: typeof pack.thankYouText === "string" ? pack.thankYouText : survey.thankYouText,
    questions: survey.questions.map((question) => {
      const text = questions[question.id]?.text;
      return {
        ...question,
        text: typeof text === "string" && text.length > 0 ? text : question.text,
        options: question.options.map((option) => {
          const label = option.translations?.[locale];
          return typeof label === "string" && label.length > 0 ? { ...option, label } : option;
        }),
      };
    }),
  };
}

function hasContent(answer: AnswerInput | undefined): boolean {
  if (!answer) return false;
  return (
    (answer.optionIds?.length ?? 0) > 0 ||
    typeof answer.numberValue === "number" ||
    (answer.textValue?.trim().length ?? 0) > 0 ||
    (answer.otherText?.trim().length ?? 0) > 0
  );
}

/**
 * The multi-question survey state machine, shared by both surfaces.
 *
 * Same rules as the single-question hook, in order of how often they matter:
 * - Never show a buyer an error. Any unrecoverable failure hides the block.
 * - Never block the page.
 * - Never ask twice. The server's unique constraint is the real guard.
 *
 * Unlike the old hook, answers are collected across several questions and
 * submitted together. A question answered "Other" waits for its free text before
 * the set can be submitted.
 */
export function useMultiSurvey(
  orderId: string,
  placement: Placement,
  api: MultiSurveyApi,
) {
  const [phase, setPhase] = useState<MultiPhase>("loading");
  const [survey, setSurvey] = useState<CompiledSurvey | null>(null);
  const [answers, setAnswers] = useState<AnswerState>({});
  const [step, setStep] = useState(0);

  const submitted = useRef(false);
  const mounted = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // The order id arrives from an async subscription. Wait for a real id so we
    // never fire `?orderId=`, which the route would reject.
    if (!orderId) return;

    const locale = apiRef.current.getLocale?.() ?? null;
    apiRef.current.fetchSurvey(orderId, placement, locale).then((result) => {
      if (cancelled || !mounted.current) return;

      const config = result;
      if (
        !config ||
        !config.enabled ||
        config.alreadyAnswered ||
        !config.survey ||
        config.survey.questions.length === 0
      ) {
        log("survey_hidden", {
          placement,
          reason: config?.alreadyAnswered ? "already_answered" : "backend_unreachable",
        });
        setPhase("hidden");
        return;
      }

      // Apply the buyer's language to the merchant-authored text, and remember
      // it so the answer is stored with the language the buyer actually read.
      setSurvey(localizeSurvey(config.survey, locale));
      setPhase("asking");
    });

    return () => {
      cancelled = true;
    };
  }, [orderId, placement]);

  /** Visible questions in definition order. */
  const visibleQuestions = useMemo(() => {
    if (!survey) return [];
    return survey.questions.filter((question) => questionVisible(question, answers));
  }, [survey, answers]);

  const oneByOne = survey?.layout === "one_by_one";
  const current = oneByOne ? visibleQuestions[Math.min(step, Math.max(visibleQuestions.length - 1, 0))] : undefined;
  const shown = oneByOne ? (current ? [current] : []) : visibleQuestions;

  const setAnswer = useCallback((questionId: string, patch: Partial<AnswerInput>) => {
    setAnswers((prev) => ({ ...prev, [questionId]: { ...prev[questionId], ...patch, questionId } }));
  }, []);

  /**
   * Submit a full set. Reads the answers from a ref so a single-question tap can
   * submit the answer it just set, without waiting for a re-render.
   */
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const send = useCallback(
    async (finalAnswers: AnswerState) => {
      if (submitted.current || !survey) return;
      submitted.current = true;
      setPhase("sending");

      const visible = survey.questions.filter((question) => questionVisible(question, finalAnswers));
      const payload: AnswerInput[] = visible.map((question) => ({
        ...(finalAnswers[question.id] ?? {}),
        questionId: question.id,
      }));

      const result = await apiRef.current.submitAnswers({
        surveyId: survey.id,
        orderId,
        placement,
        answers: payload,
      });
      if (!mounted.current) return;

      if (result === null) {
        log("survey_submit_lost", { placement });
        setPhase("hidden");
        return;
      }

      setPhase("done");
      setTimeout(() => {
        if (mounted.current) setPhase("hidden");
      }, CONFIRMATION_MS);
    },
    [survey, orderId, placement],
  );

  /**
   * A tap on an answer. On a one-question survey laid out in full, the tap
   * submits immediately — the classic thank-you-page behaviour, one tap and the
   * buyer is done. Multi-question surveys collect answers and submit on Submit.
   */
  const answer = useCallback(
    (questionId: string, patch: Partial<AnswerInput>) => {
      if (submitted.current) return;
      const next = { ...answersRef.current, [questionId]: { ...answersRef.current[questionId], ...patch, questionId } };
      answersRef.current = next;
      setAnswers(next);

      const singleQuestion = survey?.questions.length === 1 && survey.layout === "all";
      if (!singleQuestion) return;

      // A single-choice "Other" must wait for its free text, so only auto-submit
      // when the question has no pending "Other" requirement.
      const question = survey?.questions[0];
      if (!question) return;
      const chosen = next[questionId]?.optionIds?.[0];
      const isOther = question.options.find((o) => o.id === chosen)?.isOther || chosen === OTHER_CHANNEL;
      if (isOther && (next[questionId]?.otherText?.trim().length ?? 0) === 0) return;

      void send(next);
    },
    [survey, send],
  );

  const complete = useMemo(() => {
    for (const question of visibleQuestions) {
      const answer = answers[question.id];
      if (!hasContent(answer)) {
        if (question.required) return false;
        continue;
      }
      if (question.type === "single_choice" || question.type === "dropdown") {
        const chosen = answer?.optionIds?.[0];
        const option = question.options.find((o) => o.id === chosen);
        if ((option?.isOther || chosen === OTHER_CHANNEL) && (answer?.otherText?.trim().length ?? 0) === 0) {
          return false;
        }
      }
    }
    return true;
  }, [visibleQuestions, answers]);

  const next = useCallback(() => setStep((s) => Math.min(s + 1, Math.max(visibleQuestions.length - 1, 0))), [
    visibleQuestions.length,
  ]);
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);

  return {
    phase,
    survey,
    answers,
    shown,
    oneByOne,
    step,
    total: visibleQuestions.length,
    complete,
    setAnswer: answer,
    next,
    back,
    submit: () => void send(answersRef.current),
    busy: phase === "sending",
    t: api.t,
  };
}
