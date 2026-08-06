/**
 * Customization pillar DTOs — schema engine + theme (T6).
 *
 * Typed bodies/resources for the SDK auto-render contract (SPEC §3.2) and the
 * per-merchant branding feed (SPEC §3.1). Arbitrary JSON Schema 2020-12 and
 * UI-extension documents travel as loosely-typed objects; only their object-ness
 * is enforced at the transport boundary (the deep validation is the concern of
 * the hand-rolled `validator.ts`).
 */
import { t } from "elysia";
import type { Static } from "typebox";

/** Object transport for an arbitrary JSON document (schema or ui-extensions). */
const JsonObject = t.Record(t.String(), t.Unknown());

/** PUT body — the JSON Schema 2020-12 document plus optional per-field UI hints. */
export const SchemaPutBody = t.Object({
  schema: JsonObject,
  ui: t.Optional(JsonObject),
});
export type SchemaPutBody = Static<typeof SchemaPutBody>;

/** Contract the SDK auto-renders from: raw schema + ui extensions + version. */
export const SchemaResource = t.Object({
  schema: JsonObject,
  ui: t.Optional(JsonObject),
  version: t.Integer({ minimum: 1 }),
});
export type SchemaResource = Static<typeof SchemaResource>;

/** PUT body for the theme (all fields optional; service fills in defaults). */
export const ThemePutBody = t.Object({
  primary_color: t.Optional(t.String()),
  radius: t.Optional(t.String()),
  dark_mode: t.Optional(t.Boolean()),
  css: t.Optional(t.String()),
  branding: t.Optional(t.Record(t.String(), t.Unknown())),
});
export type ThemePutBody = Static<typeof ThemePutBody>;

/** Theme resource as served back (normalized with defaults applied). */
export const ThemeResource = t.Object({
  primary_color: t.String(),
  radius: t.String(),
  dark_mode: t.Boolean(),
  css: t.Optional(t.Union([t.String(), t.Null()])),
  branding: t.Optional(t.Union([t.Record(t.String(), t.Unknown()), t.Null()])),
});
export type ThemeResource = Static<typeof ThemeResource>;
