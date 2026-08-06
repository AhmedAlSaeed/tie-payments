/**
 * Customization pillar — schema engine + theme (T6).
 *
 * Registers `/v1/schema/:target_entity` (PUT/GET/DELETE) and `/v1/theme`
 * (GET/PUT) — the SDK auto-render contract (SPEC §3.2) and the future-HPP
 * branding feed (SPEC §3.1). The module carries its own `/v1` prefix (unlike
 * pillar modules that mount under the versioned router), so production mounts
 * it directly: `.use(createCustomizationModule(db))`.
 *
 * Mutating PUTs honor `Idempotency-Key` (replays return the cached response
 * byte-for-byte) and schema writes enforce optimistic concurrency via
 * `If-Match` (D5): missing/mismatched version → 409 conflict.
 */
import { Elysia, t } from "elysia";
import type { Surreal } from "surrealdb";
import { createContextAuth } from "../../core/context";
import { namespaceIdempotencyKey, SurrealIdempotencyStore, problem } from "../../core/idempotency";
import { SchemaPutBody, ThemePutBody } from "./model";
import { SchemaRepository, ThemeRepository } from "./repository";
import { CustomizationService } from "./service";

export function createCustomizationModule(db: Surreal) {
  const idempotencyStore = new SurrealIdempotencyStore(db);
  const service = new CustomizationService(new SchemaRepository(db), new ThemeRepository(db));

  return new Elysia({ name: "modules.customization", prefix: "/v1" })
    .use(createContextAuth(db))
    .put(
      "/schema/:targetEntity",
      {
        body: SchemaPutBody,
        params: t.Object({ targetEntity: t.String({ minLength: 1, maxLength: 64 }) }),
        headers: t.Object({
          "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
          "if-match": t.Optional(t.String()),
        }),
      },
      async ({ body, params, headers, merchantId, environment }) => {
        const rawKey = headers["idempotency-key"];
        const nsKey = rawKey
          ? namespaceIdempotencyKey(
              merchantId,
              environment,
              `/v1/schema/${params.targetEntity}`,
              rawKey,
            )
          : undefined;

        if (nsKey) {
          const outcome = await idempotencyStore.claim({ merchantId, environment }, nsKey);
          if (outcome === "replay") {
            const cached = await idempotencyStore.get({ merchantId, environment }, nsKey);
            if (cached) {
              return new Response(cached.body, { status: cached.status, headers: cached.headers });
            }
          }
          if (outcome === "conflict") {
            throw problem(
              "idempotency_conflict",
              "Concurrent request with the same Idempotency-Key is in progress.",
            );
          }
        }

        const resource = await service.putSchema(
          { merchantId, environment },
          params.targetEntity,
          body,
          headers["if-match"],
        );

        if (nsKey) {
          await idempotencyStore.commit({ merchantId, environment }, nsKey, {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(resource),
          });
        }
        return resource;
      },
    )
    .get(
      "/schema/:targetEntity",
      { params: t.Object({ targetEntity: t.String({ minLength: 1, maxLength: 64 }) }) },
      async ({ params, merchantId, environment }) => {
        const resource = await service.getSchema({ merchantId, environment }, params.targetEntity);
        if (!resource) {
          throw problem("resource_not_found", `No schema defined for '${params.targetEntity}'.`);
        }
        return resource;
      },
    )
    .delete(
      "/schema/:targetEntity",
      { params: t.Object({ targetEntity: t.String({ minLength: 1, maxLength: 64 }) }) },
      async ({ params, merchantId, environment, set }) => {
        await service.deleteSchema({ merchantId, environment }, params.targetEntity);
        set.status = 204;
        return "";
      },
    )
    .get("/theme", {}, async ({ merchantId, environment }) => {
      return service.getTheme({ merchantId, environment });
    })
    .put(
      "/theme",
      {
        body: ThemePutBody,
        headers: t.Object({
          "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
        }),
      },
      async ({ body, headers, merchantId, environment }) => {
        const rawKey = headers["idempotency-key"];
        const nsKey = rawKey
          ? namespaceIdempotencyKey(merchantId, environment, "/v1/theme", rawKey)
          : undefined;

        if (nsKey) {
          const outcome = await idempotencyStore.claim({ merchantId, environment }, nsKey);
          if (outcome === "replay") {
            const cached = await idempotencyStore.get({ merchantId, environment }, nsKey);
            if (cached) {
              return new Response(cached.body, { status: cached.status, headers: cached.headers });
            }
          }
          if (outcome === "conflict") {
            throw problem(
              "idempotency_conflict",
              "Concurrent request with the same Idempotency-Key is in progress.",
            );
          }
        }

        const resource = await service.putTheme({ merchantId, environment }, body);

        if (nsKey) {
          await idempotencyStore.commit({ merchantId, environment }, nsKey, {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(resource),
          });
        }
        return resource;
      },
    );
}
