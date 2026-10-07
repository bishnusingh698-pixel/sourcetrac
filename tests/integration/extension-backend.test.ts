import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSurveyApi, SUBMIT_BUDGET_MS, TransientError } from "../../extensions/shared/src/survey-logic";

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
  questionText: "How did you hear about us?",
  options: [
    { value: "instagram", label: "Instagram", emoji: "" },
    { value: "google", label: "Google", emoji: "" },
  ],
  allowOther: false,
  alreadyAnswered: false,
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

    const result = await api().fetchSurveyConfig("1", "thank-you");

    expect(result).toMatchObject({ questionText: "How did you hear about us?" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // `orderConfirmation.value.order.id` is the numeric id, the same value the
    // orders/create webhook puts in `order_id`. A GID here would be rejected by
    // the route's numeric check and never attributed.
    expect(url).toBe(`${API_URL}/api/survey-config?orderId=1`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-session-token");
  });

  it("gives up quietly on a 401 rather than retrying forever", async () => {
    // A 401 can never succeed on retry: the token is bad or expired. The block
    // must hide, and it must do so promptly.
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().fetchSurveyConfig("1", "thank-you");
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

    const promise = api().fetchSurveyConfig("1", "thank-you");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ questionText: "How did you hear about us?" });
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

    const promise = api().fetchSurveyConfig("1", "thank-you");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ allowOther: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 rather than hammering the backend", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1 ? json({}, 429) : json(CONFIG);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().fetchSurveyConfig("1", "thank-you");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null rather than throwing when the service never recovers", async () => {
    // The contract that protects the thank-you page: a failure here must never
    // surface to the buyer as an error state.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().submitResponse("1", "instagram", null, "thank-you");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps retrying for the full budget during a long cold start", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const promise = api().fetchSurveyConfig("1", "thank-you");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
    // It must not give up in the first few seconds; a 60-90s boot is the
    // scenario this budget exists for.
    expect(Date.now() - started).toBeGreaterThanOrEqual(SUBMIT_BUDGET_MS - 1000);
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

    const promise = api().fetchSurveyConfig("1", "thank-you");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
  });

  it("submits the channel and returns the stored result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ ok: true, alreadyAnswered: false, status: "recorded" }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().submitResponse("1", "instagram", null, "thank-you");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ ok: true });
    const [, submitInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(submitInit.body));
    expect(body).toMatchObject({ orderId: "1", channel: "instagram" });
  });

  it("treats a duplicate submission as a success, not an error", async () => {
    // Flow 1: a double-tap or refresh must never show the buyer a failure.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ ok: true, alreadyAnswered: true, status: "duplicate" }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = api().submitResponse("1", "instagram", null, "thank-you");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ ok: true, alreadyAnswered: true });
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
    const promise = bound.fetchSurveyConfig("1", "thank-you");
    await vi.runAllTimersAsync();
    await promise;

    expect(getSessionToken).toHaveBeenCalledTimes(2);
  });

  it("marks permanent failures as non-retryable", () => {
    expect(new TransientError(false, "x").retryable).toBe(false);
  });
});
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("use-survey orderId guard", () => {
  /**
   * Both extension blocks call `useSurvey(orderId ?? "", ...)` because the id
   * comes from an async remote-ui subscription and is undefined on first render.
   * The hook must therefore refuse to fetch until a real id arrives — otherwise
   * every Thank-you / Order-status load fires `?orderId=`, which the route
   * rejects as a permanent 422 and the retry loop logs as a give-up.
   *
   * NOTE: this asserts the guard's *presence in the source*, not the hook's
   * runtime behaviour — there is no React renderer or jsdom in this project, so
   * mounting `useSurvey` would mean adding a test-renderer dependency. It is a
   * structural check: it fails if the early return is deleted or moved after the
   * fetch, which is the regression that matters, but it cannot catch a guard that
   * is present yet bypassed. Behavioural coverage of the fetch/retry logic lives
   * in the tests above, which drive the real `createSurveyApi`.
   */
  it("guards the config effect with an empty-orderId early return", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "extensions", "shared", "src", "use-survey.ts"),
      "utf8",
    );

    const effect = /useEffect\(\(\) => \{[\s\S]*?\n  \}, \[orderId, surface\]\);/.exec(source);
    expect(effect, "expected a useEffect whose deps include orderId").not.toBeNull();

    const body = effect?.[0] ?? "";
    const guardIndex = body.indexOf("if (!orderId) return;");
    const fetchIndex = body.indexOf("fetchSurveyConfig(");

    expect(guardIndex, "useEffect must early-return on an empty orderId").toBeGreaterThan(-1);
    expect(
      fetchIndex,
      "the guard must precede fetchSurveyConfig, otherwise it guards nothing",
    ).toBeGreaterThan(guardIndex);
  });
});

describe("checkout editor preview", () => {
  /**
   * The editor has no real order, so without a preview the block rendered
   * nothing and a merchant who added it saw an empty block. The editor must
   * also never fetch or submit: an answer there would be written against a
   * placeholder order. Structural, for the same reason as the guard above.
   */
  for (const file of [
    ["sourcetrac-thank-you", "ThankYouBlock.tsx"],
    ["sourcetrac-order-status", "OrderStatusBlock.tsx"],
  ] as const) {
    it(`${file[1]} renders the preview in the editor without an order id`, () => {
      const source = readFileSync(
        join(import.meta.dirname, "..", "..", "extensions", file[0], "src", file[1]),
        "utf8",
      );

      expect(source).toMatch(/const inEditor = api\.extension\.editor !== undefined;/);
      expect(source).toMatch(/useSurvey\(inEditor \? "" : /);

      const previewIndex = source.indexOf("<SurveyPreview");
      const liveIndex = source.indexOf("<SurveyView");
      const nullIndex = source.indexOf("return null;");
      expect(previewIndex, "the editor must get the preview").toBeGreaterThan(-1);
      // The missing-order `return null` would otherwise blank the editor again.
      expect(previewIndex).toBeLessThan(nullIndex);
      expect(previewIndex).toBeLessThan(liveIndex);
    });
  }
});
