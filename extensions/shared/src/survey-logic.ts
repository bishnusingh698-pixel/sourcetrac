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
    } catch (error) {
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

    if (!response.ok) {
      // 429 and 5xx mean slow down or the server is unwell.
      throw new TransientError(true, `server returned ${response.status}`);
    }

    return (await response.json()) as T;
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
        const wait = Math.min(backoff, remaining);
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
        body: JSON.stringify({ orderId, channel, otherText }),
      }),
    );
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

  return { fetchSurveyConfig, submitResponse, t };
}