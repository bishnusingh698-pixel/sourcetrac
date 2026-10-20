import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import {
  log,
  orderOptionsForBuyer,
  OTHER_CHANNEL,
  type AnswerInput,
  type CompiledOption,
  type CompiledQuestion,
  type CompiledSurvey,
  type Placement,
  type SubmitResult,
  type SurveyConfigV2,
  type SurveyPreview,
} from "./survey-logic";

export type MultiPhase = "loading" | "asking" | "sending" | "done" | "hidden";

/** How long the confirmation stays visible before the block collapses. */
const CONFIRMATION_MS = 2500;

export interface MultiSurveyApi {
  fetchSurvey: (
    orderId: string,
    placement: Placement,
    locale: string | null,
    surveyId?: string | null,
  ) => Promise<SurveyConfigV2 | null>;
  /** The checkout editor's read of the merchant's real survey. */
  fetchPreview?: (placement: Placement, surveyId: string | null) => Promise<SurveyPreview | null>;
  submitAnswers: (params: {
    surveyId: string;
    surveyVersion?: number;
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

/**
 * The visible questions, in order. Like `validateResponse` on the server, a
 * show-if condition only reads answers to questions that are themselves
 * visible: an answer left on a question that a later change hid must not keep
 * its dependants visible, or the submission is rejected as `hidden_answered`.
 */
export function visibleQuestionsFor(questions: readonly CompiledQuestion[], answers: AnswerState): CompiledQuestion[] {
  const visibleAnswers: AnswerState = {};
  const visible: CompiledQuestion[] = [];
  for (const question of questions) {
    if (!questionVisible(question, visibleAnswers)) continue;
    visible.push(question);
    const answer = answers[question.id];
    if (answer) visibleAnswers[question.id] = answer;
  }
  return visible;
}

/** Question types answered by a single tap, which a one-question survey submits at once. */
const SINGLE_TAP_TYPES = new Set(["single_choice", "dropdown", "yes_no", "rating_5", "nps", "satisfaction_5"]);

/** The options to render, including the synthetic "Other" when free text is on. */
export function optionsFor(question: CompiledQuestion, otherLabel: string): CompiledOption[] {
  const base = question.options;
  if (!question.allowOther || base.some((o) => o.isOther || o.id === OTHER_CHANNEL)) return base;
  return [...base, { id: OTHER_CHANNEL, label: otherLabel, isOther: true }];
}

/**
 * The stored language key that best matches the buyer's language tag.
 *
 * Checkout reports a BCP-47 tag, which may carry a region ("de-DE", "pt-BR").
 * Translations are stored under the app's own codes ("de", "pt-BR", "zh-CN"),
 * so an exact match is tried first, then the bare language, then any stored
 * code for the same language ("pt" finds "pt-BR").
 */
export function matchLocale(locale: string | null, available: readonly string[]): string | null {
  if (!locale) return null;
  const wanted = locale.toLowerCase();
  const exact = available.find((code) => code.toLowerCase() === wanted);
  if (exact) return exact;
  const base = wanted.split("-")[0] ?? wanted;
  const bare = available.find((code) => code.toLowerCase() === base);
  if (bare) return bare;
  return available.find((code) => code.toLowerCase().split("-")[0] === base) ?? null;
}

/**
 * Overlay the buyer's language onto a compiled survey.
 *
 * Two places hold translations: the survey's own `translations` (frame text,
 * plus question text keyed by id in older surveys), and each question's and
 * option's `translations`, which surveys created from a template carry for
 * every language the templates ship. Falls back to the default text for any
 * string a locale does not define.
 */
export function localizeSurvey(survey: CompiledSurvey, locale: string | null): CompiledSurvey {
  if (!locale) return survey;
  const packs = (survey.translations ?? {}) as Record<string, Record<string, unknown>>;
  const codes = new Set(Object.keys(packs));
  for (const question of survey.questions) {
    for (const code of Object.keys(question.translations ?? {})) codes.add(code);
    for (const option of question.options) for (const code of Object.keys(option.translations ?? {})) codes.add(code);
  }
  const code = matchLocale(locale, [...codes]);
  if (!code) return survey;
  const pack = packs[code] ?? {};

  const legacyQuestions = (pack.questions as Record<string, Record<string, string>> | undefined) ?? {};
  const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    ...survey,
    title: text(pack.title) ?? survey.title,
    intro: pack.intro != null ? String(pack.intro) : survey.intro,
    buttonLabel: text(pack.buttonLabel) ?? survey.buttonLabel,
    thankYouText: text(pack.thankYouText) ?? survey.thankYouText,
    questions: survey.questions.map((question) => {
      const own = question.translations?.[code];
      return {
        ...question,
        text: text(legacyQuestions[question.id]?.text) ?? text(own?.text) ?? question.text,
        helpText: text(own?.helpText) ?? question.helpText,
        placeholder: text(own?.placeholder) ?? question.placeholder,
        options: question.options.map((option) => {
          const label = text(option.translations?.[code]);
          return label ? { ...option, label } : option;
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
  options: {
    /** The block's "Survey ID" setting, already cleaned. */
    surveyId?: string | null;
    /**
     * Checkout editor: load the merchant's real survey with no order, and let
     * them click through it without anything being sent.
     */
    preview?: boolean;
  } = {},
) {
  const surveyId = options.surveyId ?? null;
  const preview = options.preview === true;
  const [phase, setPhase] = useState<MultiPhase>("loading");
  const [survey, setSurvey] = useState<CompiledSurvey | null>(null);
  const [previewInfo, setPreviewInfo] = useState<Omit<SurveyPreview, "survey"> | null>(null);
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
    const locale = apiRef.current.getLocale?.() ?? null;

    if (preview) {
      // The editor re-renders as the merchant edits the Survey ID setting, so
      // each change starts again from a clean slate.
      submitted.current = false;
      setAnswers({});
      setStep(0);
      setPhase("loading");
      const fetchPreview = apiRef.current.fetchPreview;
      if (!fetchPreview) {
        setPhase("hidden");
        return;
      }
      fetchPreview(placement, surveyId).then((result) => {
        if (cancelled || !mounted.current) return;
        if (!result) {
          setPreviewInfo(null);
          setSurvey(null);
          setPhase("hidden");
          return;
        }
        const { survey: previewSurvey, ...info } = result;
        setPreviewInfo(info);
        if (!previewSurvey || previewSurvey.questions.length === 0) {
          setSurvey(null);
          setPhase("hidden");
          return;
        }
        setSurvey(localizeSurvey(previewSurvey, locale));
        setPhase("asking");
      });
      return () => {
        cancelled = true;
      };
    }

    // The order id arrives from an async subscription. Wait for a real id so we
    // never fire `?orderId=`, which the route would reject.
    if (!orderId) return;

    apiRef.current.fetchSurvey(orderId, placement, locale, surveyId).then((result) => {
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
          // The merchant's Surveys page lists the server's reason for each
          // load under "Recent checkouts".
          reason: !config ? "backend_unreachable" : config.alreadyAnswered ? "already_answered" : "no_matching_survey",
        });
        setPhase("hidden");
        return;
      }

      // Apply the buyer's language to the merchant-authored text, and remember
      // it so the answer is stored with the language the buyer actually read.
      // Randomised options are shuffled once, seeded by the order's numeric
      // id, so the order is stable for this buyer and identical on both pages
      // (their GIDs differ: OrderIdentity on Thank-you, Order on Order status).
      const localized = localizeSurvey(config.survey, locale);
      const seed = orderId.match(/(\d+)$/)?.[1] ?? orderId;
      setSurvey({
        ...localized,
        questions: localized.questions.map((question) => ({
          ...question,
          options: orderOptionsForBuyer(question.options, question.randomizeOptions === true, seed),
        })),
      });
      setPhase("asking");
    });

    return () => {
      cancelled = true;
    };
  }, [orderId, placement, surveyId, preview]);

  /** Visible questions in definition order. */
  const visibleQuestions = useMemo(() => {
    if (!survey) return [];
    return visibleQuestionsFor(survey.questions, answers);
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

      if (preview) {
        // Nothing is sent from the editor. Show the thank-you message, then
        // start over so the merchant can try another path through the survey.
        setPhase("done");
        setTimeout(() => {
          if (!mounted.current) return;
          submitted.current = false;
          answersRef.current = {};
          setAnswers({});
          setStep(0);
          setPhase("asking");
        }, CONFIRMATION_MS);
        return;
      }

      // Only questions the buyer actually answered: a skipped optional
      // question sent as an empty entry was stored as an empty answer and
      // counted in that question's totals.
      const visible = visibleQuestionsFor(survey.questions, finalAnswers);
      const payload: AnswerInput[] = visible
        .filter((question) => hasContent(finalAnswers[question.id]))
        .map((question) => ({ ...(finalAnswers[question.id] ?? {}), questionId: question.id }));

      const result = await apiRef.current.submitAnswers({
        surveyId: survey.id,
        surveyVersion: survey.version,
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
    [survey, orderId, placement, preview],
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

      // Only a tap submits: text, multiple choice and the "Other" box are typed
      // or built up, so they wait for the Submit button (submitting on the first
      // keystroke stored "a" and ignored the rest of the typing).
      const question = survey?.questions[0];
      if (!question || !SINGLE_TAP_TYPES.has(question.type)) return;
      if (patch.optionIds === undefined && patch.numberValue === undefined) return;
      const chosen = next[questionId]?.optionIds?.[0];
      const isOther = question.options.find((o) => o.id === chosen)?.isOther || chosen === OTHER_CHANNEL;
      if (isOther) return;

      void send(next);
    },
    [survey, send],
  );

  const complete = useMemo(() => {
    // At least one answer: the server refuses an empty set, so a survey whose
    // questions are all optional must not offer Submit before anything is
    // picked (the tap used to fail and the buyer saw nothing happen).
    let answered = 0;
    for (const question of visibleQuestions) {
      const state = questionState(question, answers[question.id]);
      if (state === "invalid") return false;
      if (state === "answered") answered += 1;
    }
    return answered > 0;
  }, [visibleQuestions, answers]);

  // One question at a time: Next waits until the current question is answered
  // (or is optional and left empty), so a required question is never skipped
  // only to leave Submit disabled at the end with nothing saying why.
  const canAdvance = current ? questionState(current, answers[current.id]) !== "invalid" : true;

  const next = useCallback(() => setStep((s) => Math.min(s + 1, Math.max(visibleQuestions.length - 1, 0))), [
    visibleQuestions.length,
  ]);
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);

  return {
    phase,
    survey,
    /** In the editor: which survey is shown and why, or why nothing is. */
    previewInfo,
    answers,
    shown,
    oneByOne,
    step,
    total: visibleQuestions.length,
    complete,
    canAdvance,
    setAnswer: answer,
    next,
    back,
    submit: () => void send(answersRef.current),
    busy: phase === "sending",
    t: api.t,
  };
}

/**
 * Whether one visible question is answered, left empty (fine when optional) or
 * in a state the server would refuse. The same rules the server enforces, so
 * Submit is never enabled for a set the server would refuse (and the answer
 * lost).
 */
function questionState(question: CompiledQuestion, answer: AnswerInput | undefined): "answered" | "empty" | "invalid" {
  if (!hasContent(answer)) return question.required ? "invalid" : "empty";
  if (question.type === "single_choice" || question.type === "dropdown" || question.type === "multi_choice") {
    const chosen = answer?.optionIds ?? [];
    const otherChosen = chosen.some((id) => id === OTHER_CHANNEL || question.options.find((o) => o.id === id)?.isOther);
    if (otherChosen && (answer?.otherText?.trim().length ?? 0) === 0) return "invalid";
    if (question.type === "multi_choice") {
      const unique = [...new Set(chosen)];
      // An exclusive option ("None of these") stands alone, whatever the minimum.
      const onlyExclusive = unique.length === 1 && question.options.find((o) => o.id === unique[0])?.exclusive === true;
      if (typeof question.minSelections === "number" && unique.length < question.minSelections && !onlyExclusive) {
        return "invalid";
      }
      if (typeof question.maxSelections === "number" && unique.length > question.maxSelections) return "invalid";
    }
  }
  return "answered";
}
