import { env } from "~/lib/env";
import { logger } from "~/lib/logger";

/**
 * Keep the web service from going to sleep.
 *
 * Render's free plan stops a service after 15 minutes without an incoming
 * request, and the next request waits about a minute for it to start again.
 * For a buyer that minute is the checkout survey sitting on "Loading…", or
 * never appearing, since the block gives up after 60 seconds. An outside
 * uptime pinger prevents it, but only if someone has set one up.
 *
 * So the server asks for its own `/healthz` through its public URL every ten
 * minutes. The request goes out and back in through Render's front door, which
 * is what counts as traffic. `/healthz` never touches the database, so Neon
 * still suspends when idle and no compute hours are spent on these pings.
 *
 * Off outside production, and with `KEEP_AWAKE=off`.
 */

export const KEEP_AWAKE_INTERVAL_MS = 10 * 60 * 1000;

const PING_TIMEOUT_MS = 30_000;

type Options = {
  appUrl: string;
  nodeEnv: string;
  setting?: "on" | "off";
  intervalMs?: number;
  fetchImpl?: typeof fetch;
};

/** Whether the pings run, and where they go. Exported for tests. */
export function keepAwakeTarget({ appUrl, nodeEnv, setting }: Pick<Options, "appUrl" | "nodeEnv" | "setting">): string | null {
  if (setting === "off") return null;
  if (nodeEnv !== "production" && setting !== "on") return null;
  let url: URL;
  try {
    url = new URL("/healthz", appUrl);
  } catch {
    return null;
  }
  // A local or plain-HTTP address is a developer machine, not a host that sleeps.
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
  return url.toString();
}

const started = Symbol.for("sourcetrac.keepAwake");

/** Start the pings once per process. Returns a stop function (for tests). */
export function startKeepAwake(options: Options): () => void {
  const target = keepAwakeTarget(options);
  const holder = globalThis as { [started]?: () => void };
  if (!target) return () => {};
  if (holder[started]) return holder[started];

  const fetchImpl = options.fetchImpl ?? fetch;
  const ping = async () => {
    try {
      const response = await fetchImpl(target, {
        method: "GET",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        headers: { "User-Agent": "SourceTrac keep-awake" },
      });
      // Drain the body so the connection is released.
      await response.text();
      if (!response.ok) logger.warn("keep_awake_ping_status", { status: response.status });
    } catch (error) {
      logger.warn("keep_awake_ping_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const timer = setInterval(() => void ping(), options.intervalMs ?? KEEP_AWAKE_INTERVAL_MS);
  // Never hold the process open on its own.
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    delete holder[started];
  };
  holder[started] = stop;
  logger.info("keep_awake_started", { target, interval_ms: options.intervalMs ?? KEEP_AWAKE_INTERVAL_MS });
  return stop;
}

/** Start from the app's environment. Never throws: a bad setting must not stop the boot. */
export function startKeepAwakeFromEnv(): void {
  try {
    const { APP_URL, NODE_ENV, KEEP_AWAKE } = env();
    startKeepAwake({ appUrl: APP_URL, nodeEnv: NODE_ENV, setting: KEEP_AWAKE });
  } catch (error) {
    logger.warn("keep_awake_not_started", { error: error instanceof Error ? error.message : String(error) });
  }
}
