/**
 * Surface-agnostic survey behaviour.
 *
 * The thank-you page and the order-status page render the same question, so the
 * rules about retrying, collapsing and never showing a buyer an error live here
 * once. Each extension supplies its own React components and hooks because the
 * two surfaces ship from different packages (`ui-extensions-react/checkout`
 * vs `.../customer-account`) and do not share an import path.
 */

export type SurveySurface = "thank-you" | "order-status";

/** Where a survey can appear. Mirrors PLACEMENTS in shared/survey-config.ts. */
export type Placement = "thank_you" | "order_status" | "onsite" | "link";

/** One answer the buyer gave, in the wire shape the backend expects. */
export type AnswerInput = {
  questionId: string;
  optionIds?: string[];
  numberValue?: number | null;
  textValue?: string | null;
  otherText?: string | null;
};

export type CompiledOption = {
  id: string;
  label: string;
  isOther: boolean;
  /** T6: selecting it clears the others in multiple choice. */
  exclusive?: boolean;
  translations?: Record<string, string | undefined>;
};

export type CompiledQuestion = {
  id: string;
  type: string;
  text: string;
  helpText?: string | null;
  placeholder?: string | null;
  textMultiline: boolean;
  required: boolean;
  randomizeOptions: boolean;
  allowOther: boolean;
  minSelections?: number | null;
  maxSelections?: number | null;
  showIf?: { questionId: string; optionIds?: string[]; min?: number; max?: number } | null;
  options: CompiledOption[];
  translations?: Record<string, { text?: string; helpText?: string; placeholder?: string } | undefined>;
};

export type CompiledSurvey = {
  id: string;
  version: number;
  priority: number;
  placements: Placement[];
  layout: "all" | "one_by_one";
  title: string;
  intro: string | null;
  buttonLabel: string;
  thankYouText: string;
  channelReportQuestionId: string | null;
  targeting: Record<string, unknown>;
  questions: CompiledQuestion[];
  translations?: Record<string, unknown>;
};

/** Shape returned by GET /api/survey. */
export type SurveyConfigV2 = {
  enabled: boolean;
  orderId: string | null;
  placement: Placement;
  alreadyAnswered: boolean;
  survey: CompiledSurvey | null;
};

/** Shape returned by GET /api/survey-preview (checkout editor only). */
export type SurveyPreview = {
  survey: CompiledSurvey | null;
  name: string | null;
  status: "draft" | "active" | "paused" | null;
  pinned: boolean;
  /** False when the survey is not set to show on the page this block is on. */
  onThisPage: boolean;
  reason: "not_found" | "none_live" | null;
};

/**
 * The block's "Survey ID" setting as the server expects it, or null. Merchants
 * paste it, so stray spaces and capitals are forgiven; anything that cannot be
 * an id is dropped rather than sent.
 */
export function cleanSurveyId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return /^[a-z0-9]{8,40}$/.test(id) ? id : null;
}

/**
 * Sentinel channel for the free-text answer. Must match
 * `OTHER_CHANNEL_VALUE` in app/lib/settings.ts, which the submit route
 * allowlists against.
 */
export const OTHER_CHANNEL = "other";

export interface SurveyOption {
  /** Merchant-defined channel key, e.g. "google". Sent verbatim on submit. */
  value: string;
  label: string;
  emoji: string | null;
}

/**
 * The choices to render: the merchant's options, plus an "Other" choice when
 * free-text answers are on.
 *
 * The config lists only the merchant's own options. Without this the buyer had
 * nothing to tap that reveals the free-text field, so the merchant's "Allow a
 * free-text answer" switch silently did nothing. Skipped when the merchant
 * already named an option "Other", whose slug is the same value, so the
 * buyer never sees two.
 */
export function surveyChoices(
  options: SurveyOption[],
  allowOther: boolean,
  otherLabel: string,
): SurveyOption[] {
  if (!allowOther || options.some((option) => option.value === OTHER_CHANNEL)) return options;
  return [...options, { value: OTHER_CHANNEL, label: otherLabel, emoji: null }];
}

/**
 * T6 for a multi-choice control: reconcile the selection the host reports after
 * a tap with the exclusive rule.
 *
 * `s-choice-list` hands back the *whole* new value array, not which option was
 * tapped, so the tapped option is the id that differs from `previous`. Tapping
 * an exclusive option leaves just it; tapping any other drops the exclusive
 * ones. Without this a buyer could hold an exclusive option and another, which
 * the submit route rejects as `exclusive_with_others`, losing the answer.
 *
 * The checkout renderer mirrors `reconcileMultiChoiceSelection` from
 * shared/survey-rules.ts rather than importing it (separate bundles), so the two
 * must agree; `tests/unit/exclusive-option.test.ts` pins them together.
 */
export function applyExclusiveToggle(
  exclusiveIds: readonly string[],
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const exclusive = new Set(exclusiveIds);
  const added = next.find((id) => !previous.includes(id));
  if (added) {
    // The buyer tapped `added`. An exclusive tap stands alone; a normal tap
    // clears any exclusive option that was selected before.
    return exclusive.has(added) ? [added] : next.filter((id) => !exclusive.has(id));
  }
  // A pure deselection, or no change: whatever remains is already valid because
  // the previous value was.
  return [...next];
}

export interface SurveyConfig {
  enabled: boolean;
  questionText: string;
  options: SurveyOption[];
  allowOther: boolean;
  orderId?: string;
  /** True when this order already answered on the other surface. */
  alreadyAnswered?: boolean;
  reason?: "not_installed" | "plan_unsupported" | "not_found";
}

/**
 * Shape returned by POST /api/responses.
 *
 * The route does not expose per-outcome detail: it returns `ok: true` for both a
 * fresh write and a duplicate, because a buyer who has answered should always
 * see the confirmation. `counted: false` means the store is over its free cap —
 * the answer is still stored and flagged, only the merchant is prompted.
 */
export interface SubmitResult {
  ok: boolean;
  counted: boolean;
}

/**
 * Total wall-clock budget for one submission. A Render free web service spins
 * down when idle, so the first request after a quiet period pays the full wake
 * latency. The brief allows 60-90s of cold start; we stop at 60s so the survey
 * can still collapse cleanly before the buyer navigates away.
 */
export const SUBMIT_BUDGET_MS = 60_000;

/**
 * Per-attempt ceiling. Sits above the documented cold-start range so a waking
 * service is given room to finish booting before the attempt is called dead.
 */
export const ATTEMPT_TIMEOUT_MS = 30_000;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Statuses where the request itself is wrong, so retrying cannot help. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

export class TransientError extends Error {
  constructor(
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

export function log(event: string, detail: Record<string, unknown> = {}): void {
  // console is the only logger available inside an extension's Web Worker.
  console.log(`[sourcetrac] ${event}`, JSON.stringify(detail));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ApiBinding {
  /**
   * Mints a session token. `useSessionToken()` returns a `SessionToken` whose
   * `get()` re-mints when the cached one has expired, so this is safe to call on
   * every attempt: a retry after a long cold start will not reuse a stale JWT.
   */
  getSessionToken: () => Promise<string>;
  translate: (key: string) => unknown;
  /** The buyer's language (e.g. "de"), stored with the answer. Optional. */
  getLocale?: () => string | null | undefined;
  /**
   * The selected payment option `type`s for this checkout (T7). Only the
   * Thank-you block can provide this; elsewhere it is absent and the server
   * treats an empty list as "not a manual payment". Optional so the
   * order-status and admin blocks need not implement it.
   */
  getPaymentTypes?: () => readonly string[];
  /**
   * Whether this is the buyer's first completed order, and the buyer's country
   * (ISO 3166-1 alpha-2). Both feed server-side targeting; without them the
   * route passed `null` and any survey targeting first/returning customers or a
   * country never matched, so it silently never appeared. Optional: an
   * unavailable value is simply not sent, and the server then treats a
   * first/returning or country rule as not met (the Order-status page has no
   * first-order signal), so a targeted survey is never shown to an unknown
   * audience.
   */
  getIsFirstOrder?: () => boolean | null | undefined;
  getCountry?: () => string | null | undefined;
  /** Numeric product ids on the order (Thank-you only), for results by product. */
  getProductIds?: () => readonly string[];
}

/** The log label for a placement; only Order-status is not the Thank-you page. */
function surfaceOf(placement: Placement): SurveySurface {
  return placement === "order_status" ? "order-status" : "thank-you";
}

/**
 * Answer options in display order: the non-"Other" options shuffled with a
 * Fisher–Yates shuffle seeded by the order id when the merchant turned
 * randomisation on, "Other" always last. Mirrors `orderOptions` in
 * shared/survey-rules.ts (this bundle cannot import it); the two are pinned to
 * identical output by tests/unit/exclusive-option.test.ts.
 */
export function orderOptionsForBuyer<T extends { isOther?: boolean }>(
  options: readonly T[],
  randomize: boolean,
  seed: string,
): T[] {
  const other = options.filter((o) => o.isOther);
  const rest = options.filter((o) => !o.isOther);
  if (!randomize || rest.length < 2) return [...rest, ...other];

  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const x = shuffled[i] as T;
    shuffled[i] = shuffled[j] as T;
    shuffled[j] = x;
  }
  return [...shuffled, ...other];
}

/**
 * Builds the request/translate helpers for one extension, bound to that
 * extension's own hooks.
 */
export function createSurveyApi(apiUrl: string, binding: ApiBinding) {
  async function attempt<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

    let response: Response;
    try {
      // Minted inside the try so the attempt timeout covers it. `getSessionToken`
      // asks Shopify to sign a JWT, which is a network call of its own; when it
      // hangs, the timer aborts the fetch that follows but the await above it
      // would have kept the promise alive indefinitely, pushing the loop past
      // its budget on a single stuck attempt.
      const token = await binding.getSessionToken();

      response = await fetch(`${apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        // Read the body under the same timer: a stalled body otherwise left the
        // block on "sending" forever. A body that cannot be read or parsed is
        // retried like any transient failure; the server treats the retry of a
        // committed answer as a duplicate success.
        try {
          return (await response.json()) as T;
        } catch (bodyError) {
          const aborted = bodyError instanceof Error && bodyError.name === "AbortError";
          throw new TransientError(true, aborted ? "attempt timed out" : "unreadable response body");
        }
      }
    } catch (error) {
      if (error instanceof TransientError) throw error;
      // Network failure, DNS, TLS or our own abort. All retryable: the most
      // common cause by far is a service still booting.
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new TransientError(true, aborted ? "attempt timed out" : "network error");
    } finally {
      clearTimeout(timer);
    }

    if (PERMANENT_STATUSES.has(response.status)) {
      // 401 means our session token was rejected. Retrying cannot fix it, so
      // surface it immediately and let the caller hide the block.
      throw new TransientError(false, `request rejected with ${response.status}`);
    }

    // 429 and 5xx mean slow down or the server is unwell.
    throw new TransientError(true, `server returned ${response.status}`);
  }

  /**
   * Retry with exponential backoff until the budget is spent.
   *
   * Resolves null on exhaustion rather than throwing: a buyer who has answered
   * must never see a failure state for an analytics question.
   */
  async function withRetries<T>(
    label: string,
    surface: SurveySurface,
    run: () => Promise<T>,
  ): Promise<T | null> {
    const deadline = Date.now() + SUBMIT_BUDGET_MS;
    let backoff = INITIAL_BACKOFF_MS;
    let attemptNumber = 0;

    for (;;) {
      attemptNumber += 1;

      try {
        return await run();
      } catch (error) {
        const retryable = error instanceof TransientError ? error.retryable : false;
        const remaining = deadline - Date.now();

        if (!retryable || remaining <= 0) {
          log(`${label}_gave_up`, {
            surface,
            attempts: attemptNumber,
            retryable,
            reason: error instanceof Error ? error.message : "unknown",
          });
          return null;
        }

        // Back off, but never past the deadline.
        //
        // No attempt is skipped for being "too expensive". During a cold start
        // attempts fail *fast* — connection refused, not a 30s hang — and the
        // whole point of the 60s budget is to keep retrying through exactly
        // that. Requiring `remaining` to exceed ATTEMPT_TIMEOUT_MS would abandon
        // a booting service after 30s, the scenario the budget exists for.
        //
        // The residual overrun when the host is hard-down is bounded: this
        // deadline check runs on every iteration, so the worst case is the final
        // attempt running to its own timeout past the budget, then giving up.
        //
        // Jittered to 50-100% of the step: every buyer's block hitting the same
        // cold-starting instance otherwise retried in lockstep, a thundering
        // herd at each doubling.
        const wait = Math.min(Math.round(backoff * (0.5 + Math.random() * 0.5)), remaining);
        log(`${label}_retrying`, { surface, attempt: attemptNumber, wait_ms: wait });
        await sleep(wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  function fetchSurveyConfig(orderId: string, surface: SurveySurface) {
    return withRetries("survey_config", surface, () =>
      attempt<SurveyConfig>(`/api/survey-config?orderId=${encodeURIComponent(orderId)}`, {
        method: "GET",
      }),
    );
  }

  /**
   * The v2 multi-question config. One active survey for this order and
   * placement, already compiled server-side.
   */
  function fetchSurvey(orderId: string, placement: Placement, locale: string | null, surveyId?: string | null) {
    const query = new URLSearchParams({ placement });
    if (orderId) query.set("orderId", orderId);
    if (locale) query.set("locale", locale);
    // The block's "Survey ID" setting: show that survey, not the priority pick.
    if (surveyId) query.set("surveyId", surveyId);
    // T7: only the Thank-you block binds this. Sending it here keeps the payment
    // rule server-side, so a survey that targets manual payment methods is
    // matched against the real selection rather than always seeing an empty list.
    const paymentTypes = safeRead(() => binding.getPaymentTypes?.()) ?? [];
    if (paymentTypes.length > 0) query.set("paymentTypes", paymentTypes.join(","));
    // First/returning and country targeting. Only sent when the host actually
    // exposes the value: an absent signal must leave the rule inert, not hide
    // the survey from every buyer.
    const isFirstOrder = safeRead(() => binding.getIsFirstOrder?.());
    if (typeof isFirstOrder === "boolean") query.set("isFirstOrder", isFirstOrder ? "1" : "0");
    const country = safeRead(() => binding.getCountry?.());
    if (typeof country === "string" && country.length > 0) query.set("country", country.slice(0, 2).toUpperCase());
    return withRetries("survey_fetch", surfaceOf(placement), () =>
      attempt<SurveyConfigV2>(`/api/survey?${query.toString()}`, { method: "GET" }),
    );
  }

  /**
   * The merchant's real survey for the checkout editor, which has no order. A
   * read only: the editor preview never submits.
   */
  function fetchPreview(placement: Placement, surveyId: string | null) {
    const query = new URLSearchParams({ placement });
    if (surveyId) query.set("surveyId", surveyId);
    return withRetries("survey_preview", surfaceOf(placement), () =>
      attempt<SurveyPreview>(`/api/survey-preview?${query.toString()}`, { method: "GET" }),
    );
  }

  function submitResponse(
    orderId: string,
    channel: string,
    otherText: string | null,
    surface: SurveySurface,
  ) {
    return withRetries("survey_submit", surface, () =>
      attempt<SubmitResult>("/api/responses", {
        method: "POST",
        // Field names must match app/routes/api.responses.tsx exactly. The route
        // allowlists `channel` against the merchant's configured options, so
        // renaming this silently breaks every submission with a 422.
        body: JSON.stringify({ orderId, channel, otherText, locale: buyerLocale() }),
      }),
    );
  }

  /** Submit a full multi-question answer set. */
  function submitAnswers(params: {
    surveyId: string;
    surveyVersion?: number;
    orderId: string | null;
    placement: Placement;
    answers: AnswerInput[];
  }) {
    return withRetries("survey_answers", surfaceOf(params.placement), () =>
      attempt<SubmitResult>("/api/survey-responses", {
        method: "POST",
        // Field names must match app/routes/api.survey-responses.tsx exactly.
        body: JSON.stringify({
          surveyId: params.surveyId,
          surveyVersion: params.surveyVersion,
          orderId: params.orderId,
          placement: params.placement,
          locale: buyerLocale(),
          answers: params.answers,
          // Order facts stored with the answer: first-order presets and results
          // by product read them. Sent only when the host exposes them.
          ...submitFacts(),
        }),
      }),
    );
  }

  function submitFacts(): { isFirstOrder?: boolean; country?: string; productIds?: string[] } {
    const facts: { isFirstOrder?: boolean; country?: string; productIds?: string[] } = {};
    const isFirstOrder = safeRead(() => binding.getIsFirstOrder?.());
    if (typeof isFirstOrder === "boolean") facts.isFirstOrder = isFirstOrder;
    const country = safeRead(() => binding.getCountry?.());
    if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country)) facts.country = country.toUpperCase();
    const productIds = safeRead(() => binding.getProductIds?.()) ?? [];
    const unique = [...new Set(productIds)].filter((id) => /^\d+$/.test(id)).slice(0, 10);
    if (unique.length > 0) facts.productIds = unique;
    return facts;
  }

  /** Read a host value without letting a throwing signal break the request. */
  function safeRead<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }

  /** Never throws: a missing localization API must not block the answer. */
  function buyerLocale(): string | null {
    try {
      const locale = binding.getLocale?.();
      return typeof locale === "string" && locale.length > 0 ? locale.slice(0, 32) : null;
    } catch {
      return null;
    }
  }

  /** Translation with a literal fallback, so a missing key never blanks the UI. */
  function t(key: string, fallback: string): string {
    try {
      const value = binding.translate(key);
      return typeof value === "string" && value.length > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  }

  return { fetchSurveyConfig, fetchSurvey, fetchPreview, submitResponse, submitAnswers, getLocale: buyerLocale, t };
}