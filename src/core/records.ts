/**
 * Record-id helpers for parameterized SurrealDB queries.
 *
 * Plain strings are NOT coerced to `record<...>` values in parameterized
 * queries, so record links must be bound as SDK `RecordId` objects (or built
 * with `type::record(...)` in SurrealQL). Read rows return record links as
 * `RecordId` instances, whose `String()` serialization wraps non-simple keys in
 * angle brackets (`merchant:⟨uuid⟩`); these helpers canonicalize both directions
 * to the bracket-free `table:<key>` string used across the codebase.
 */
import { RecordId } from "surrealdb";

export type RecordRef = string | RecordId;

/** Convert `merchant:<key>` (or any `table:<key>`) into a bound RecordId. */
export function recordIdOf(id: RecordRef): RecordId {
  if (id instanceof RecordId) return id;
  const normalized = String(id).replace(/[⟨⟩]/g, "");
  const idx = normalized.indexOf(":");
  if (idx === -1) return new RecordId(normalized, "");
  return new RecordId(normalized.slice(0, idx), normalized.slice(idx + 1));
}

/** Canonical bracket-free `table:<key>` string for a record reference. */
export function recordIdToString(id: RecordRef): string {
  if (id instanceof RecordId) return `${id.table}:${id.id}`;
  return String(id).replace(/[⟨⟩]/g, "");
}
