/**
 * Surface-agnostic survey behaviour.
 *
 * The Thank-you page and the Order status page render the same survey, so the
 * rules about retrying, collapsing and never showing a buyer an error live here
 * once, apart from the blocks' components, so they can be tested without a
 * checkout host and shared with the admin blocks.
 */

export type SurveySurface = "thank-you" | "order-status";

/**
 * Where a survey can appear. Mirrors PLACEMENTS in shared/survey-config.ts,
 * which keeps the retired pages (On-site, Survey link) so historic answers
 * still read. Surveys show on `thank_you`, and on `order_status` when the
 * merchant opts in.
 */
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
  /** F4: shown only to buyers in these countries. Absent: everyone. */
  countries?: string[];
};

/**
 * The answers a buyer in `country` sees: every answer without a country list,
 * and those whose list names the buyer's country. When the checkout does not
 * say where the buyer is, every answer is shown: hiding answers from a buyer we
 * know nothing about would bias the results more than showing one extra.
 */
export function optionsForCountry<T extends { countries?: string[]; isOther?: boolean }>(
  options: readonly T[],
  country: string | null,
): T[] {
  if (!country) return [...options];
  const code = country.toUpperCase();
  const kept = options.filter((option) => !option.countries || option.countries.length === 0 || option.countries.includes(code));
  // A question left with nothing to pick (every answer limited elsewhere)
  // would block a required question: show every answer instead.
  return kept.some((option) => !option.isOther) ? kept : [...options];
}

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
  priority?: number;
  placements: Placement[];
  layout: "all" | "one_by_one";
  title: string;
  intro: string | null;
  buttonLabel: string;
  thankYouText: string;
  /** Merchant settings: decided on the server and not sent to buyers. */
  channelReportQuestionId?: string | null;
  targeting?: Record<string, unknown>;
  questions: CompiledQuestion[];
  translations?: Record<string, unknown>;
  /** The merchant's look settings. Absent from configs compiled by older servers. */
  design?: SurveyDesign;
};

/**
 * The look settings the merchant picked in the survey editor. Mirrors
 * `CompiledDesign` in shared/survey-config.ts (this bundle cannot import it).
 * Fonts and colours are never here: they come from the store's checkout.
 */
export type SurveyDesign = {
  layout?: "all" | "one_by_one";
  showProgress?: boolean;
  showTitle?: boolean;
  ratingStyle?: "numbers" | "stars";
  scaleLowLabel?: string;
  scaleHighLabel?: string;
  cardBorder?: "border" | "no_border";
  spacing?: "compact" | "comfortable";
};

/**
 * The editor's default scale labels, as stored in English. A label equal to one
 * of these (or empty) is "not customised": the block shows its own translated
 * default instead, so a German buyer never reads "Very poor". Mirrors
 * `DEFAULT_DESIGN` and `DEFAULT_NPS_SCALE` in shared/survey-rules.ts.
 */
const DEFAULT_SCALE_LABELS = new Set(["", "Very poor", "Excellent", "Not likely", "Very likely"]);

/**
 * The words under a rating or 0–10 scale: the merchant's own when they wrote
 * some, otherwise the block's translated defaults for that kind of scale.
 */
export function scaleAnchors(
  type: "rating_5" | "nps",
  design: SurveyDesign | undefined,
  t: (key: string, fallback: string) => string,
): { low: string; high: string } {
  const own = (value: string | undefined) => {
    const trimmed = (value ?? "").trim();
    return DEFAULT_SCALE_LABELS.has(trimmed) ? null : trimmed;
  };
  const low =
    own(design?.scaleLowLabel) ??
    (type === "nps" ? t("sourcetrac.npsLow", "Not likely") : t("sourcetrac.ratingLow", "Very poor"));
  const high =
    own(design?.scaleHighLabel) ??
    (type === "nps" ? t("sourcetrac.npsHigh", "Very likely") : t("sourcetrac.ratingHigh", "Excellent"));
  return { low, high };
}

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
  /** Live, but beyond the plan's number of live surveys. Absent from older servers. */
  planHidden?: boolean;
  /** Rules under "Who sees it" keep some orders from seeing it. */
  audienceRules?: boolean;
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
 * Option id of the built-in "Other" choice (`optionsFor`). Must match
 * `OTHER_CHANNEL_VALUE` in shared/survey-rules.ts, which the submit route
 * validates against.
 */
export const OTHER_CHANNEL = "other";

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

/**
 * Shape returned by POST /api/survey-responses.
 *
 * The route does not expose per-outcome detail: it returns `ok: true` for both a
 * fresh write and a duplicate, because a buyer who has answered should always
 * see the confirmation. `counted: false` means the store is over its free cap —
 * the answer is still stored and flagged, only the merchant is prompted.
 */
export interface SubmitResult {
  ok: boolean;
  counted: boolean;
  /**
   * Set by the block itself (never by the server) when the server refused the
   * answer outright (400, 401...). Sending it again cannot help, so it is not
   * kept for a later load.
   */
  rejected?: boolean;
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

/**
 * At most this many attempts per request. With the backoff below (1s doubling
 * to 16s, jittered) eight attempts span roughly the 60s budget, so a cold
 * start is still waited out, but a fast-failing request stops after eight.
 */
export const MAX_ATTEMPTS = 8;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

/**
 * Statuses where the request itself is wrong, so retrying cannot help. 410 is
 * the Shopify library's bot filter: the same request is refused every time.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 410, 413, 422]);

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
   * first/returning or country rule as not met (the Order status page has no
   * first-order signal of its own and relies on what the Thank-you page
   * reported), so a targeted survey is never shown to an unknown audience.
   */
  getIsFirstOrder?: () => boolean | null | undefined;
  getCountry?: () => string | null | undefined;
  /**
   * The order total the page shows (`cost.totalAmount`). Sent for the
   * order-value rule only: on the Thank-you page the order webhook has usually
   * not arrived yet, so the server has no total of its own and the rule used to
   * be skipped, showing the survey on every order.
   */
  getOrderTotal?: () => { amount: number; currencyCode: string } | null | undefined;
  /** Numeric product ids on the order, for results by product and product targeting. */
  getProductIds?: () => readonly string[];
  /**
   * The extension's `storage` API, where an answer that could not be sent is
   * kept for the next load (see `useMultiSurvey`). Optional.
   */
  storage?: {
    read: (key: string) => Promise<unknown>;
    write: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
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
  async function attempt<T>(
    path: string,
    init: RequestInit,
    options: { tokenFailureIsFinal?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ATTEMPT_TIMEOUT_MS);

    let response: Response;
    try {
      // Minted inside the try so the attempt timeout covers it. `getSessionToken`
      // asks Shopify to sign a JWT, which is a network call of its own; when it
      // hangs, the timer aborts the fetch that follows but the await above it
      // would have kept the promise alive indefinitely, pushing the loop past
      // its budget on a single stuck attempt.
      let token: string;
      try {
        // Raced against the attempt's own timer: an await on a token request
        // that never settles is not interrupted by aborting the fetch after it.
        token = await new Promise<string>((resolve, reject) => {
          const onAbort = () => {
            const aborted = new Error("session token request timed out");
            aborted.name = "AbortError";
            reject(aborted);
          };
          if (controller.signal.aborted) return onAbort();
          controller.signal.addEventListener("abort", onAbort, { once: true });
          binding.getSessionToken().then(resolve, reject).finally(() => {
            controller.signal.removeEventListener("abort", onAbort);
          });
        });
      } catch (tokenError) {
        if (tokenError instanceof Error && tokenError.name === "AbortError") throw tokenError;
        // In the checkout editor a host that refuses a token will keep
        // refusing it, so the preview gives up at once instead of showing
        // "Loading…" for a minute. Buyers keep retrying, as before.
        if (options.tokenFailureIsFinal) throw new TransientError(false, "session token unavailable");
        throw tokenError;
      }

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
    run: (timeoutMs: number) => Promise<T>,
    onGiveUp?: (retryable: boolean) => void,
  ): Promise<T | null> {
    const deadline = Date.now() + SUBMIT_BUDGET_MS;
    let backoff = INITIAL_BACKOFF_MS;
    let attemptNumber = 0;

    for (;;) {
      attemptNumber += 1;

      try {
        // An attempt never runs past the budget: one started near the
        // deadline gets only what is left (but at least a few seconds).
        return await run(Math.min(ATTEMPT_TIMEOUT_MS, Math.max(deadline - Date.now(), 5_000)));
      } catch (error) {
        const retryable = error instanceof TransientError ? error.retryable : false;
        const remaining = deadline - Date.now();

        if (!retryable || remaining <= 0 || attemptNumber >= MAX_ATTEMPTS) {
          onGiveUp?.(retryable);
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
        // The residual overrun when the host is hard-down is bounded: each
        // attempt's timeout is capped at what is left of the budget (at least
        // 5s), and the loop stops after MAX_ATTEMPTS.
        //
        // Jittered to 50-100% of the step: every buyer's block hitting the same
        // cold-starting instance otherwise retried in lockstep, a thundering
        // herd at each doubling.
        //
        // The last of the MAX_ATTEMPTS is held back to the end of the budget,
        // so a cold start that takes the whole minute is still caught.
        const jittered = Math.round(backoff * (0.5 + Math.random() * 0.5));
        const lastAttemptNext = attemptNumber === MAX_ATTEMPTS - 1;
        const wait = Math.min(lastAttemptNext ? Math.max(jittered, remaining - 1_000) : jittered, remaining);
        log(`${label}_retrying`, { surface, attempt: attemptNumber, wait_ms: wait });
        await sleep(wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
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
    // F5: the order's products, for "only orders with these products". Sent
    // whenever the host exposes lines, even with none we can read, so the
    // server can tell "no matching product" from "an older block".
    const products = binding.getProductIds ? safeRead(() => binding.getProductIds?.()) : undefined;
    if (Array.isArray(products)) {
      const ids = [...new Set(products)].filter((id) => /^\d{1,20}$/.test(id)).slice(0, 25);
      query.set("products", ids.join(","));
    }
    const total = safeRead(() => binding.getOrderTotal?.());
    if (total && Number.isFinite(total.amount) && total.amount >= 0 && /^[A-Za-z]{3}$/.test(total.currencyCode)) {
      query.set("total", String(total.amount));
      query.set("totalCurrency", total.currencyCode.toUpperCase());
    }
    return withRetries("survey_fetch", surfaceOf(placement), (timeoutMs) =>
      attempt<SurveyConfigV2>(`/api/survey?${query.toString()}`, { method: "GET" }, { timeoutMs }),
    );
  }

  /**
   * The merchant's real survey for the checkout editor, which has no order. A
   * read only: the editor preview never submits.
   */
  function fetchPreview(placement: Placement, surveyId: string | null) {
    const query = new URLSearchParams({ placement });
    if (surveyId) query.set("surveyId", surveyId);
    return withRetries("survey_preview", surfaceOf(placement), (timeoutMs) =>
      attempt<SurveyPreview>(
        `/api/survey-preview?${query.toString()}`,
        { method: "GET" },
        { tokenFailureIsFinal: true, timeoutMs },
      ),
    );
  }

  /** Submit a full multi-question answer set. */
  async function submitAnswers(params: {
    surveyId: string;
    surveyVersion?: number;
    orderId: string | null;
    placement: Placement;
    answers: AnswerInput[];
  }): Promise<SubmitResult | null> {
    let refused = false;
    const result = await withRetries("survey_answers", surfaceOf(params.placement), (timeoutMs) =>
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
      }, { timeoutMs }),
      (retryable) => {
        refused = !retryable;
      },
    );
    // Null still means "could not be sent"; a refusal is told apart so the
    // block does not keep an answer the server will never take.
    return result ?? (refused ? { ok: false, counted: false, rejected: true } : null);
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

  /** The buyer's checkout country (ISO alpha-2), or null. */
  function buyerCountry(): string | null {
    const country = safeRead(() => binding.getCountry?.());
    return typeof country === "string" && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
  }

  return {
    fetchSurvey,
    fetchPreview,
    submitAnswers,
    getLocale: buyerLocale,
    getCountry: buyerCountry,
    storage: binding.storage,
    t,
  };
}