import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSurveyApi, MAX_ATTEMPTS, SUBMIT_BUDGET_MS, TransientError } from "../../extensions/shared/src/survey-logic";

/**
 * Extension -> backend contract.
 *
 * These drive the real `createSurveyApi` used by both extensions. Only the
 * network boundary is replaced (a `fetch` double), so the retry, backoff, auth
 * and give-up logic under test is the code that actually ships.
 *
 * The cold-start case is the one that matters most: a free Render service can
 * take 60-90s to boot, and the survey must survive that without breaking the
 * buyer's thank-you page.
 */

const API_URL = "https://sourcetrac.test";

const CONFIG = {
  enabled: true,
  orderId: "1",
  placement: "thank_you",
  alreadyAnswered: false,
  survey: { id: "survey-1", title: "Quick question", questions: [] },
};

const ANSWER = {
  surveyId: "survey-1",
  surveyVersion: 1,
  orderId: "1",
  placement: "thank_you" as const,
  answers: [{ questionId: "q1", optionIds: ["instagram"] }],
};

function api() {
  return createSurveyApi(API_URL, {
    getSessionToken: async () => "test-session-token",
    translate: (key: string) => key,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("extension -> backend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetches survey config and sends the session token as a bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(CONFIG));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api().fetchSurvey("1", "thank_you", null);

    expect(result).toMatchObject({ enabled: true, survey: { id: "survey-1" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/api/survey?placement=thank_you&orderId=1`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-session-token");
  });

  it("gives up quietly on a 401 rather than retrying forever", async () => {
    // A 401 can never succeed on retry: the token is bad or expired. The block
    // must hide, and it must do so promptly.
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and then succeeds, as during a cold start", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      return call < 3 ? json({ error: "booting" }, 503) : json(CONFIG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("survives a network error, which is what a booting Render service looks like", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new TypeError("Failed to fetch");
      return json(CONFIG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 rather than hammering the backend", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1 ? json({}, 429) : json(CONFIG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null rather than throwing when the service never recovers", async () => {
    // The contract that protects the thank-you page: a failure here must never
    // surface to the buyer as an error state.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().submitAnswers(ANSWER);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps retrying for the full budget during a long cold start", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
    // It must not give up in the first few seconds; a 60-90s boot is the
    // scenario this budget exists for.
    expect(Date.now() - started).toBeGreaterThanOrEqual(SUBMIT_BUDGET_MS - 1000);
  });

  it("stops after the attempt cap, within the budget (L2)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "busy" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(MAX_ATTEMPTS);
    expect(Date.now() - started).toBeLessThanOrEqual(SUBMIT_BUDGET_MS + 1_000);
  });

  it("gives up on a session token request that never settles (M9)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hung = createSurveyApi(API_URL, {
      getSessionToken: () => new Promise<string>(() => undefined),
      translate: (key: string) => key,
    });
    const promise = hung.fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an attempt that hangs instead of blocking the page forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );

    const promise = api().fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
  });

  it("submits the answer set and returns the stored result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, counted: true }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().submitAnswers(ANSWER);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ ok: true, counted: true });
    const [submitUrl, submitInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe(`${API_URL}/api/survey-responses`);
    // Field names must match app/routes/api.survey-responses.tsx exactly.
    expect(JSON.parse(String(submitInit.body))).toMatchObject({
      surveyId: "survey-1",
      orderId: "1",
      placement: "thank_you",
      answers: [{ questionId: "q1", optionIds: ["instagram"] }],
    });
  });

  it("treats a duplicate submission as a success, not an error", async () => {
    // Flow 1: a double-tap or refresh must never show the buyer a failure.
    // The route answers a duplicate exactly like a fresh write.
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, counted: true }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().submitAnswers(ANSWER);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: true, counted: true });
  });

  it("mints a fresh session token for each attempt", async () => {
    // A long cold start can outlive the cached JWT. If the token were cached
    // by the caller, the retry would fail auth after ~1 minute.
    const getSessionToken = vi.fn().mockResolvedValue("token");
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => json({}, 503))
      .mockImplementation(async () => json(CONFIG));
    vi.stubGlobal("fetch", fetchMock);

    const bound = createSurveyApi(API_URL, { getSessionToken, translate: (k: string) => k });
    const promise = bound.fetchSurvey("1", "thank_you", null);
    await vi.runAllTimersAsync();
    await promise;

    expect(getSessionToken).toHaveBeenCalledTimes(2);
  });

  it("marks permanent failures as non-retryable", () => {
    expect(new TransientError(false, "x").retryable).toBe(false);
  });
});
