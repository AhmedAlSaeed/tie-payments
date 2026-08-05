/**
 * Error plugin — installs the app-wide Problem Details handler.
 *
 * Registers `ProblemError` with Elysia so services can `throw new ProblemError`
 * and get the RFC 9457 payload automatically. Also normalizes validation
 * failures (code `VALIDATION`) into the same taxonomy. Mounted globally so the
 * envelope is consistent across every pillar that `use`s this plugin.
 *
 * Elysia 2.0 note: the error lifecycle is registered via `.error(...)` (this
 * replaces 1.x `onError`). Custom error classes are registered with
 * `.error(Class, handler)` — the handler's context `error` is narrowed to an
 * instance of `Class`. The generic `.error(handler)` form catches everything
 * else; there is no `code` string on the context in 2.0, so built-in errors
 * are discriminated with `instanceof` (`ValidationError`, `NotFound`).
 */
import { Elysia, NotFound, t, ValidationError } from "elysia";
import { ProblemError } from "./errors";

function problemBody(
  code: string,
  title: string,
  detail: string,
  status: number,
  errors?: unknown,
) {
  return {
    type: `urn:tie:problem:${code}`,
    title,
    status,
    detail,
    code,
    ...(errors ? { errors } : {}),
  };
}

export const errorHandling = new Elysia({ name: "core.error" })
  // Custom ProblemError — trust its own status + toResponse().
  .error(ProblemError, ({ error }) => error.toResponse())
  // Validation failures → 400 with a stable machine code (no schema leakage).
  // Elysia ships its own handler for ValidationError, so we override it by
  // registering this class specifically (a bare `.error(({error}) => ...)`
  // catch-all runs only for unregistered classes).
  .error(ValidationError, ({ error, set }) => {
    set.status = 400;
    return problemBody(
      "validation_error",
      "Request validation failed",
      "One or more fields failed validation. See errors.",
      400,
      error.all?.map((x) => ({ field: x.path ?? "", message: x.message ?? "" })),
    );
  })
  // Registered routes not found → 404 with a stable machine code.
  .error(NotFound, ({ error, set }) => {
    set.status = 404;
    return problemBody(
      "resource_not_found",
      "Resource not found",
      error.message ?? "Not found",
      404,
    );
  })
  // Fallback for anything else (ParseError, InternalServerError, ...).
  .error(({ set }) => {
    set.status = 500;
    return problemBody("internal_error", "Internal server error", "Something went wrong.", 500);
  })
  // Lifecycles registered on a plugin default to local scope and do NOT leak
  // to the mounting instance; `.as('plugin')` publishes them so every pillar
  // that `use`s this plugin inherits the same problem envelope.
  .as("plugin");

export { t };
