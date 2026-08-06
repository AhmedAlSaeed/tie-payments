/**
 * Hand-rolled JSON Schema (2020-12) validator — a pragmatic subset for the
 * merchant-defined custom-field contract (T6 / SPEC §3.2).
 *
 * Deliberately dependency-free: only the keywords the SDK auto-renders from
 * are implemented, so the driving surface stays small and type-safe. Unknown
 * keywords are ignored (JSON Schema semantics), so a stale schema can't hard-fail
 * writes — it just doesn't exercise keywords we don't yet model.
 *
 * Supported subset:
 *   type      string | number | integer | boolean | object | array
 *   properties(object)  required(object)  items(array)
 *   enum        minLength / maxLength   minimum / maximum   pattern (basic)
 *
 * `validateValue(value, schema)` is pure and returns field-scoped problems.
 * `validateMetadata(...)` loads the merchant's stored schema for a target entity
 * and throws a `validation_error` problem (fail-fast) when the value doesn't
 * conform — the D3 service-layer enforcement point.
 */
import type { Surreal } from "surrealdb";
import { problem } from "../../core/errors";
import { SchemaRepository } from "./repository";
import type { TenantScope } from "./service";

export interface ValidationProblem {
  /** JSON pointer-ish field path, e.g. `$`, `$.shipping_country`, `$items[2]`. */
  field: string;
  message: string;
}

type TypeName = "string" | "number" | "integer" | "boolean" | "object" | "array";

const TYPE_CHECKS: Record<TypeName, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "array" : typeof v;
}

/** Validate a value against a JSON Schema (2020-12 subset). Returns problems. */
export function validateValue(value: unknown, schema: unknown): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  walk(value, schema, "$", problems);
  return problems;
}

function walk(value: unknown, schema: unknown, path: string, problems: ValidationProblem[]): void {
  if (!isPlainObject(schema)) return;

  // type keyword
  if (typeof schema.type === "string" && schema.type in TYPE_CHECKS) {
    const type = schema.type as TypeName;
    if (!TYPE_CHECKS[type](value)) {
      problems.push({
        field: path,
        message: `Expected ${type}, got ${kindOf(value)}.`,
      });
    }
  }

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => Object.is(e, value))) {
    problems.push({
      field: path,
      message: `Value must be one of [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}].`,
    });
  }

  // string keywords
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      problems.push({
        field: path,
        message: `Must be at least ${schema.minLength} characters long.`,
      });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      problems.push({
        field: path,
        message: `Must be at most ${schema.maxLength} characters long.`,
      });
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          problems.push({
            field: path,
            message: `Value does not match pattern ${schema.pattern}.`,
          });
        }
      } catch {
        // An invalid user-supplied pattern is ignored rather than failing writes.
      }
    }
  }

  // numeric keywords
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push({ field: path, message: `Value must be >= ${schema.minimum}.` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push({ field: path, message: `Value must be <= ${schema.maximum}.` });
    }
  }

  // object keywords
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (
        typeof key === "string" &&
        (value === null || typeof value !== "object" || !(key in value))
      ) {
        problems.push({
          field: `${path}.${key}`,
          message: `Missing required property '${key}'.`,
        });
      }
    }
  }
  if (
    isPlainObject(schema.properties) &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        walk((value as Record<string, unknown>)[key], sub, `${path}.${key}`, problems);
      }
    }
  }

  // array keyword
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const items = value as unknown[];
    for (let i = 0; i < items.length; i++) {
      walk(items[i], schema.items, `${path}[${i}]`, problems);
    }
  }
}

/**
 * Validate a metadata object against the merchant's stored `field_schema` for a
 * target entity. Throws a `validation_error` problem (fail-fast, D3) when the
 * value is non-conforming; returns `[]` when it conforms OR when the merchant
 * has not defined a schema for that target (unset schema => no validation).
 */
export async function validateMetadata(
  db: Surreal,
  targetEntity: string,
  scope: TenantScope,
  metadata: Record<string, unknown>,
): Promise<ValidationProblem[]> {
  const repository = new SchemaRepository(db);
  const row = await repository.get(scope.merchantId, scope.environment, targetEntity);
  if (!row) return [];

  const problems = validateValue(metadata, row.schema);
  if (problems.length > 0) {
    throw problem(
      "validation_error",
      `Metadata for '${targetEntity}' does not conform to its schema.`,
      problems,
    );
  }
  return [];
}
