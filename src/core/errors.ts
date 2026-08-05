/**
 * Error taxonomy — Problem Details (RFC 9457) envelope.
 *
 * Every error response carries the same shape:
 *   { type, title, status, detail, instance, code, errors? }
 *
 * `code` is the stable machine-readable token clients branch on; `type` is a
 * you-own-it URI; `instance` is the per-request trace id for log correlation.
 *
 * This class is registered with Elysia via `.error()` so each code gets a typed
 * branch in `onError` and a stable HTTP status.
 */
export type ProblemCode =
  | "validation_error"
  | "invalid_api_key"
  | "unauthenticated"
  | "insufficient_permissions"
  | "idempotency_conflict"
  | "conflict"
  | "resource_not_found"
  | "rate_limited"
  | "gateway_error"
  | "internal_error";

const STATUS: Record<ProblemCode, number> = {
  validation_error: 400,
  invalid_api_key: 401,
  unauthenticated: 401,
  insufficient_permissions: 403,
  idempotency_conflict: 409,
  conflict: 409,
  resource_not_found: 404,
  rate_limited: 429,
  gateway_error: 502,
  internal_error: 500,
};

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: ProblemCode;
  errors?: Array<{ field: string; message: string }>;
}

export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly errors?: ProblemBody["errors"];

  constructor(code: ProblemCode, detail: string, errors?: ProblemBody["errors"]) {
    super(detail);
    this.name = "ProblemError";
    this.code = code;
    this.status = STATUS[code];
    this.errors = errors;
  }

  toResponse(): Response {
    const body: ProblemBody = {
      type: `urn:tie:problem:${this.code}`,
      title: PROBLEM_TITLES[this.code],
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(this.errors ? { errors: this.errors } : {}),
    };
    return Response.json(body, {
      status: this.status,
      headers: { "content-type": "application/problem+json" },
    });
  }
}

const PROBLEM_TITLES: Record<ProblemCode, string> = {
  validation_error: "Request validation failed",
  invalid_api_key: "API key is invalid",
  unauthenticated: "Authentication required",
  insufficient_permissions: "Key lacks permission for this operation",
  idempotency_conflict: "Concurrent request with same Idempotency-Key",
  conflict: "Request conflicts with current state",
  resource_not_found: "Resource not found",
  rate_limited: "Too many requests",
  gateway_error: "Upstream gateway error",
  internal_error: "Internal server error",
};

/** Convenience factory so services do `statusCode(409)`-like terse throws. */
export function problem(
  code: ProblemCode,
  detail: string,
  errors?: ProblemBody["errors"],
): ProblemError {
  return new ProblemError(code, detail, errors);
}
