/**
 * Customization repository — SurrealDB persistence for `field_schema` + `theme`.
 *
 * Tenancy (F0): the SurrealDB build does not reliably enforce write
 * permissions, so EVERY query here scopes by `merchant` + `environment` bound
 * from the authenticated context (`recordIdOf(...)`), matching `api_key`-derived
 * isolation. Optimistic concurrency on `field_schema` is expressed as a
 * conditional `UPDATE ... WHERE version = $expected` so a stale editor's write
 * touches zero rows (the service then surfaces a 409).
 */
import type { Surreal } from "surrealdb";
import { recordIdOf, recordIdToString } from "../../core/records";

export interface FieldSchemaRow {
  id: string;
  merchantId: string;
  environment: string;
  targetEntity: string;
  schema: Record<string, unknown>;
  ui?: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

export class SchemaRepository {
  constructor(private readonly db: Surreal) {}

  /** Fetch the schema for a scope; undefined when the merchant hasn't defined one. */
  async get(
    merchantId: string,
    environment: string,
    targetEntity: string,
  ): Promise<FieldSchemaRow | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM field_schema WHERE merchant = $merchant AND environment = $env AND target_entity = $target LIMIT 1",
        { merchant: recordIdOf(merchantId), env: environment, target: targetEntity },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapFieldSchemaRow(row) : undefined;
  }

  /** Create the first version (v1) of a schema for a scope. */
  async insert(
    merchantId: string,
    environment: string,
    targetEntity: string,
    schema: Record<string, unknown>,
    ui: Record<string, unknown> | undefined,
  ): Promise<FieldSchemaRow> {
    const id = crypto.randomUUID();
    // `ui` is option<object>: emit the field only when present so an absent
    // value stores as SurrealDB NONE rather than NULL (NULL fails the coercion).
    const uiClause = ui ? ", ui: $ui" : "";
    const params: Record<string, unknown> = {
      id,
      merchant: recordIdOf(merchantId),
      env: environment,
      target: targetEntity,
      schema,
      version: 1,
    };
    if (ui) params.ui = ui;
    await this.db.query(
      `INSERT INTO field_schema {
         id: $id,
         merchant: $merchant,
         environment: $env,
         target_entity: $target,
         schema: $schema${uiClause},
         version: $version,
         updated_at: time::now()
       }`,
      params,
    );
    return {
      id: `field_schema:${id}`,
      merchantId,
      environment,
      targetEntity,
      schema,
      ui,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Bump the version applying the caller's If-Match precondition atomically.
   * Returns the refreshed row, or `undefined` when no row matched the expected
   * version (concurrent editor / stale If-Match) — the caller surfaces a 409.
   */
  async update(
    merchantId: string,
    environment: string,
    targetEntity: string,
    schema: Record<string, unknown>,
    ui: Record<string, unknown> | undefined,
    expectedVersion: number,
  ): Promise<FieldSchemaRow | undefined> {
    const uiClause = ui ? ", ui = $ui" : "";
    const params: Record<string, unknown> = {
      schema,
      merchant: recordIdOf(merchantId),
      env: environment,
      target: targetEntity,
      expected: expectedVersion,
    };
    if (ui) params.ui = ui;
    const [rows] = await this.db
      .query(
        `UPDATE field_schema
           SET schema = $schema${uiClause},
               version = version + 1,
               updated_at = time::now()
         WHERE merchant = $merchant
           AND environment = $env
           AND target_entity = $target
           AND version = $expected`,
        params,
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapFieldSchemaRow(row) : undefined;
  }

  /** Remove a scope's schema definition. Values already stored are kept. */
  async delete(merchantId: string, environment: string, targetEntity: string): Promise<void> {
    await this.db.query(
      "DELETE FROM field_schema WHERE merchant = $merchant AND environment = $env AND target_entity = $target",
      { merchant: recordIdOf(merchantId), env: environment, target: targetEntity },
    );
  }
}

export interface ThemeRow {
  primaryColor: string;
  radius: string;
  darkMode: boolean;
  css?: string | null;
  branding?: Record<string, unknown> | null;
}

export class ThemeRepository {
  constructor(private readonly db: Surreal) {}

  async get(merchantId: string, environment: string): Promise<ThemeRow | undefined> {
    const [rows] = await this.db
      .query("SELECT * FROM theme WHERE merchant = $merchant AND environment = $env LIMIT 1", {
        merchant: recordIdOf(merchantId),
        env: environment,
      })
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapThemeRow(row) : undefined;
  }

  /** Upsert a scope's theme. Required fields always set; optional css/branding emitted only when present (NONE d.n. NULL). */
  async upsert(merchantId: string, environment: string, theme: ThemeRow): Promise<ThemeRow> {
    const setters = [`primary_color = $primaryColor`, `radius = $radius`, `dark_mode = $darkMode`];
    const params: Record<string, unknown> = {
      merchant: recordIdOf(merchantId),
      env: environment,
      primaryColor: theme.primaryColor,
      radius: theme.radius,
      darkMode: theme.darkMode,
    };
    const optional: Array<[string, string]> = [
      ["css", "$css"],
      ["branding", "$branding"],
    ];
    for (const [key, param] of optional) {
      const val = theme[key as "css" | "branding"];
      if (val === null || val === undefined) continue;
      setters.push(`${key} = ${param}`);
      params[key] = val;
    }
    const setClause = setters.join(", ");

    const [rows] = await this.db
      .query(
        `UPDATE theme SET ${setClause} WHERE merchant = $merchant AND environment = $env`,
        params,
      )
      .collect<[Array<Record<string, unknown>>]>();
    if (rows?.[0]) return theme;

    await this.db.query(
      `INSERT INTO theme {
         id: $id,
         merchant: $merchant,
         environment: $env,
         ${insertColumns(setClause)}
       }`,
      { ...params, id: crypto.randomUUID() },
    );
    return theme;
  }
}

/** Split a `a = $p, b = $q` clause into `a: $p, b: $q` column assignments. */
function insertColumns(setClause: string): string {
  return setClause
    .split(", ")
    .map((pair) => {
      const [col, ref] = pair.split(" = ");
      return `${col.trim()}: ${ref.trim()}`;
    })
    .join(", ");
}

function mapFieldSchemaRow(row: Record<string, unknown>): FieldSchemaRow {
  const ui = (row.ui as Record<string, unknown> | null) ?? undefined;
  return {
    id: recordIdToString(row.id as string),
    merchantId: recordIdToString(row.merchant as string),
    environment: String(row.environment),
    targetEntity: String(row.target_entity),
    schema: (row.schema as Record<string, unknown>) ?? {},
    ui,
    version: Number(row.version),
    updatedAt: String(row.updated_at),
  };
}

function mapThemeRow(row: Record<string, unknown>): ThemeRow {
  return {
    primaryColor: String(row.primary_color),
    radius: String(row.radius),
    darkMode: Boolean(row.dark_mode),
    css: (row.css as string | null | undefined) ?? null,
    branding: (row.branding as Record<string, unknown> | null | undefined) ?? null,
  };
}
