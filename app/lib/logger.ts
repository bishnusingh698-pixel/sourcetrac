/**
 * Structured JSON logging. One object per line so Render's log stream is
 * greppable and structured filters work.
 *
 * Never log: access tokens, session tokens, JWTs, customer email/phone,
 * or webhook payloads at info level. See docs/03 FLOW 17.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, event: string, fields: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const line = safeStringify(record);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * JSON.stringify throws on BigInt and silently drops functions/undefined.
 * Log lines must never be able to throw or lose fields.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "string") return stripNewlines(val);
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }) ?? "{}";
  } catch {
    return JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "log_serialisation_failed" });
  }
}

/** Log injection guard: a newline inside a logged string would forge a log line. */
function stripNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, "\\n").slice(0, 2000);
}

export const logger = {
  debug: (event: string, fields: LogFields = {}) => emit("debug", event, fields),
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),

  /** Returns a logger that merges `base` into every record. */
  child(base: LogFields) {
    return {
      debug: (event: string, fields: LogFields = {}) => emit("debug", event, { ...base, ...fields }),
      info: (event: string, fields: LogFields = {}) => emit("info", event, { ...base, ...fields }),
      warn: (event: string, fields: LogFields = {}) => emit("warn", event, { ...base, ...fields }),
      error: (event: string, fields: LogFields = {}) => emit("error", event, { ...base, ...fields }),
    };
  },
};

export type Logger = typeof logger;
