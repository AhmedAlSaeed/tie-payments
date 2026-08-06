/**
 * Customization service — business logic for the schema engine + theme.
 *
 * Elysia-free, mirroring the payments pillar: handlers pass a plain context and
 * the service returns typed resources or throws ProblemErrors. Owning the
 * optimistic-concurrency rule for `field_schema` (D5): first write creates v1,
 * every subsequent write requires a matching `If-Match` and bumps the version.
 */
import { problem } from "../../core/errors";
import type { SchemaPutBody, SchemaResource, ThemePutBody, ThemeResource } from "./model";
import { SchemaRepository, ThemeRepository } from "./repository";

/** Tenant scope carried from the authenticated request context. */
export interface TenantScope {
  merchantId: string;
  environment: "test" | "live";
}

const DEFAULT_THEME: Theme = {
  primary_color: "#5b4bf0",
  radius: "8px",
  dark_mode: false,
  css: null,
  branding: null,
};

interface Theme {
  primary_color: string;
  radius: string;
  dark_mode: boolean;
  css: string | null;
  branding: Record<string, unknown> | null;
}

export class CustomizationService {
  constructor(
    private readonly schemas: SchemaRepository,
    private readonly themes: ThemeRepository,
  ) {}

  /**
   * Store/update the schema+ui for a scope. Creates v1 on first write; requires
   * `If-Match` matching the current version to bump on any subsequent write.
   */
  async putSchema(
    scope: TenantScope,
    targetEntity: string,
    body: SchemaPutBody,
    ifMatch: string | undefined,
  ): Promise<SchemaResource> {
    const existing = await this.schemas.get(scope.merchantId, scope.environment, targetEntity);

    if (!existing) {
      if (ifMatch !== undefined) {
        throw problem(
          "conflict",
          `A schema for '${targetEntity}' does not exist yet; version 1 will be created without If-Match.`,
        );
      }
      const created = await this.schemas.insert(
        scope.merchantId,
        scope.environment,
        targetEntity,
        body.schema,
        body.ui,
      );
      return this.toSchemaResource(created.schema, created.ui, created.version);
    }

    const expected = parseIfMatchVersion(ifMatch);
    if (expected === undefined) {
      throw problem(
        "conflict",
        `Schema version ${existing.version} already exists; provide If-Match: ${existing.version} to update.`,
      );
    }
    if (expected !== existing.version) {
      throw problem(
        "conflict",
        `If-Match ${expected} does not match current schema version ${existing.version}.`,
      );
    }
    const updated = await this.schemas.update(
      scope.merchantId,
      scope.environment,
      targetEntity,
      body.schema,
      body.ui,
      existing.version,
    );
    if (!updated) {
      // A concurrent editor won the version bump between our read and write.
      throw problem("conflict", "Schema was modified concurrently; re-fetch and retry.");
    }
    return this.toSchemaResource(updated.schema, updated.ui, updated.version);
  }

  /** Fetch a scope's schema; the SDK auto-render contract. 404 when unset. */
  async getSchema(scope: TenantScope, targetEntity: string): Promise<SchemaResource | undefined> {
    const row = await this.schemas.get(scope.merchantId, scope.environment, targetEntity);
    if (!row) return undefined;
    return this.toSchemaResource(row.schema, row.ui, row.version);
  }

  /** Delete the scope's schema definition (metadata values are untouched). */
  async deleteSchema(scope: TenantScope, targetEntity: string): Promise<void> {
    await this.schemas.delete(scope.merchantId, scope.environment, targetEntity);
  }

  /** Fetch the scope's theme, falling back to a sensible default when unset. */
  async getTheme(scope: TenantScope): Promise<ThemeResource> {
    const row = await this.themes.get(scope.merchantId, scope.environment);
    const theme = row ? this.fromRow(row) : DEFAULT_THEME;
    return this.toThemeResource(theme);
  }

  /** Upsert the scope's theme (fields defaulted; idempotent reload-safe). */
  async putTheme(scope: TenantScope, body: ThemePutBody): Promise<ThemeResource> {
    const theme: Theme = {
      primary_color: body.primary_color ?? DEFAULT_THEME.primary_color,
      radius: body.radius ?? DEFAULT_THEME.radius,
      dark_mode: body.dark_mode ?? DEFAULT_THEME.dark_mode,
      css: body.css ?? null,
      branding: body.branding ?? null,
    };
    await this.themes.upsert(scope.merchantId, scope.environment, {
      primaryColor: theme.primary_color,
      radius: theme.radius,
      darkMode: theme.dark_mode,
      css: theme.css,
      branding: theme.branding ?? null,
    });
    return this.toThemeResource(theme);
  }

  private toSchemaResource(
    schema: Record<string, unknown>,
    ui: Record<string, unknown> | undefined,
    version: number,
  ): SchemaResource {
    return { schema, ui, version };
  }

  private fromRow(row: {
    primaryColor: string;
    radius: string;
    darkMode: boolean;
    css?: string | null;
    branding?: Record<string, unknown> | null;
  }): Theme {
    return {
      primary_color: row.primaryColor,
      radius: row.radius,
      dark_mode: row.darkMode,
      css: row.css ?? null,
      branding: row.branding ?? null,
    };
  }

  private toThemeResource(theme: Theme): ThemeResource {
    return {
      primary_color: theme.primary_color,
      radius: theme.radius,
      dark_mode: theme.dark_mode,
      css: theme.css ?? null,
      branding: theme.branding ?? null,
    };
  }
}

/** Tolerant parse of an `If-Match` version (accepts optional surrounding quotes). */
function parseIfMatchVersion(ifMatch: string | undefined): number | undefined {
  if (ifMatch === undefined) return undefined;
  const trimmed = ifMatch.trim().replace(/^"|"$/g, "");
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
