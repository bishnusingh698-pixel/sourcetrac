import { useCallback, useEffect, useRef, useState } from "react";

import {
  log,
  OTHER_CHANNEL,
  type SubmitResult,
  type SurveyConfig,
  type SurveyOption,
  type SurveySurface,
} from "./survey-logic";

export type SurveyPhase = "loading" | "asking" | "sending" | "done" | "hidden";

/** How long the confirmation stays visible before the block collapses. */
const CONFIRMATION_MS = 2500;

export interface SurveyApi {
  fetchSurveyConfig: (orderId: string, surface: SurveySurface) => Promise<SurveyConfig | null>;
  submitResponse: (
    orderId: string,
    channel: string,
    otherText: string | null,
    surface: SurveySurface,
  ) => Promise<SubmitResult | null>;
  t: (key: string, fallback: string) => string;
}

/**
 * The survey state machine, shared by both surfaces.
 *
 * Rules encoded here, in order of how often they matter in production:
 * - Never show a buyer an error. Any unrecoverable failure hides the block.
 * - Never block the page. No buyer-journey interception anywhere.
 * - Never ask twice. The server's unique constraint is the real guard; the ref
 *   below just avoids wasting a cold start on a double-tap.
 */
export function useSurvey(orderId: string, surface: SurveySurface, api: SurveyApi) {
  const [phase, setPhase] = useState<SurveyPhase>("loading");
  const [config, setConfig] = useState<SurveyConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");

  // Guards against a double-tap firing two POSTs before the first resolves.
  const submitted = useRef(false);
  // Guards against setting state after unmount during a long cold-start retry.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    api.fetchSurveyConfig(orderId, surface).then((result) => {
      if (cancelled || !mounted.current) return;

      // A null result means we never reached the backend within the retry
      // budget. Hide rather than render an empty question. A disabled config is
      // a successful answer, not a failure.
      //
      // `alreadyAnswered` is how the Thank-you and Order-status pages stay
      // mutually exclusive: whichever the customer used first wins, and the
      // other page hides rather than asking again.
      const alreadyAnswered = result?.alreadyAnswered === true;
      if (!result || !result.enabled || alreadyAnswered || result.options.length === 0) {
        log("survey_hidden", {
          surface,
          reason: alreadyAnswered ? "already_answered" : (result?.reason ?? "backend_unreachable"),
        });
        setPhase("hidden");
        return;
      }

      setConfig(result);
      setPhase("asking");
    });

    return () => {
      cancelled = true;
    };
  }, [orderId, surface, api]);

  const send = useCallback(
    async (optionId: string, other: string | null) => {
      if (submitted.current) return;
      submitted.current = true;
      setPhase("sending");

      const result = await api.submitResponse(orderId, optionId, other, surface);
      if (!mounted.current) return;

      if (result === null) {
        // Final failure after the full retry budget. The block disappears; the
        // buyer is never shown an error and the loss is already logged.
        log("survey_submit_lost", { surface });
        setPhase("hidden");
        return;
      }

      setPhase("done");
      setTimeout(() => {
        if (mounted.current) setPhase("hidden");
      }, CONFIRMATION_MS);
    },
    [api, orderId, surface],
  );

  /**
   * A tap on an option. With "Other" enabled, tapping "other" only reveals the
   * text field rather than submitting a half-typed answer.
   */
  const select = useCallback(
    (value: string) => {
      if (submitted.current) return;
      setSelected(value);

      if (value === OTHER_CHANNEL && config?.allowOther) return;

      void send(value, null);
    },
    [config?.allowOther, send],
  );

  return {
    phase,
    questionText: config?.questionText ?? "",
    options: config?.options ?? ([] as SurveyOption[]),
    allowOther: config?.allowOther ?? false,
    selected,
    otherText,
    setOtherText,
    select,
    submitOther: () => void send(OTHER_CHANNEL, otherText.trim() || null),
    busy: phase === "sending",
    t: api.t,
  };
}