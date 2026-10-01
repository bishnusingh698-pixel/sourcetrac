/**
 * Centralised error handling. Every route throws an AppError subclass; a single
 * serialiser logs once and returns a safe body. No stack traces reach clients.
 *
 * Rule from docs/03 FLOW 17: nothing is swallowed. Every catch either handles,
 * re-throws, or logs with context and a defined fallback.
 */

import { logger } from "./logger";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  /** Merchant- or buyer-facing message. Safe to render. */
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly fields: Record<string, unknown>;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    hint?: string;
    retryable?: boolean;
    fields?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = new.target.name;
    this.status = params.status;
    this.code = params.code;
    this.hint = params.hint;
    this.retryable = params.retryable ?? false;
    this.fields = params.fields ?? {};
  }
}

export class ValidationError extends AppError {
  constructor(message: string, hint?: string, fields: Record<string, unknown> = {}) {
    super({ status: 400, code: "validation_failed", message, hint, fields });
  }
}

export class AuthError extends AppError {
  constructor(reason: string, message = "Unauthorized") {
    super({ status: 401, code: "unauthorized", message, fields: { reason }, retryable: false });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", fields: Record<string, unknown> = {}) {
    super({ status: 404, code: "not_found", message, fields });
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number, fields: Record<string, unknown> = {}) {
    super({
      status: 429,
      code: "rate_limited",
      message: "Too many requests",
      hint: "Please wait a moment and try again.",
      retryable: true,
      fields: { ...fields, retry_after: retryAfterSeconds },
    });
  }
}

/** Upstream failure (Shopify, Neon, cold start). Safe for the client to retry. */
export class UpstreamError extends AppError {
  constructor(message: string, status = 503, fields: Record<string, unknown> = {}, cause?: unknown) {
    super({ status, code: "upstream_unavailable", message, retryable: true, fields, cause });
  }
}

export class InternalError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ status: 500, code: "internal_error", message, fields: {}, cause });
  }
}

export type SerialisedError = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Convert any thrown value into a client-safe body and log it once.
 * Never leaks stack traces, SQL, or upstream response bodies.
 */
export function serialiseError(error: unknown, context: Record<string, unknown> = {}): SerialisedError {
  const requestId = context.request_id ?? newRequestId();

  if (error instanceof AppError) {
    const level = error.status >= 500 ? "error" : "warn";
    logger[level]("request_error", {
      request_id: requestId,
      code: error.code,
      status: error.status,
      message: error.message,
      retryable: error.retryable,
      ...context,
      ...error.fields,
      cause: describeCause(error.cause),
    });

    const body: Record<string, unknown> = { error: error.code, request_id: requestId };
    if (error.hint) body.hint = error.hint;
    if (error.retryable) body.retryable = true;
    if (error instanceof RateLimitError) body.retry_after = error.fields.retry_after;

    return { status: error.status, body };
  }

  logger.error("request_unhandled_error", {
    request_id: requestId,
    ...context,
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return {
    status: 500,
    body: {
      error: "internal_error",
      request_id: requestId,
      hint: "Something went wrong on our end. Please try again.",
    },
  };
}

/** Extract the most useful non-secret detail from a Prisma/HTTP cause. */
function describeCause(cause: unknown): Record<string, unknown> | undefined {
  if (!cause) return undefined;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return { cause_code: code };
  }
  return { cause_type: cause instanceof Error ? cause.name : typeof cause };
}

export function newRequestId(): string {
  return `r_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
