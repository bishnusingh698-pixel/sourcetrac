import { afterEach, describe, expect, it, vi } from "vitest";

import { keepAwakeTarget, startKeepAwake } from "~/lib/keep-awake.server";

describe("keep-awake pings", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("targets /healthz on the public URL in production only", () => {
    const appUrl = "https://sourcetrac.onrender.com";
    expect(keepAwakeTarget({ appUrl, nodeEnv: "production" })).toBe("https://sourcetrac.onrender.com/healthz");
    expect(keepAwakeTarget({ appUrl, nodeEnv: "development" })).toBeNull();
    expect(keepAwakeTarget({ appUrl, nodeEnv: "production", setting: "off" })).toBeNull();
    expect(keepAwakeTarget({ appUrl: "http://localhost:3000", nodeEnv: "production", setting: "on" })).toBeNull();
  });

  it("pings every interval, once per process, and never touches anything but /healthz", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const options = { appUrl: "https://example.onrender.com", nodeEnv: "production", intervalMs: 1000, fetchImpl };
    const stop = startKeepAwake(options);
    // A second start in the same process reuses the first timer.
    const again = startKeepAwake(options);

    await vi.advanceTimersByTimeAsync(3500);
    expect(calls).toEqual(Array(3).fill("https://example.onrender.com/healthz"));

    stop();
    again();
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(3);
  });

  it("survives a failed ping", async () => {
    vi.useFakeTimers();
    let count = 0;
    const fetchImpl = (async () => {
      count += 1;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const stop = startKeepAwake({ appUrl: "https://example.onrender.com", nodeEnv: "production", intervalMs: 1000, fetchImpl });
    await vi.advanceTimersByTimeAsync(2500);
    expect(count).toBe(2);
    stop();
  });
});
