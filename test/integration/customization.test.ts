import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { provisionMerchant, type ProvisionedMerchant } from "../helpers/merchant";
import { http } from "../helpers/http";
import { errorHandling } from "../../src/core/errors-plugin";
import { createContextAuth } from "../../src/core/context";
import { createCustomizationModule } from "../../src/modules/customization";

process.env.SURREAL_TEST_DATABASE = "payments_test_t6";
const reachable = await isSurrealAvailable();

describe.skipIf(!reachable)("customization API (integration) — schema engine & theme", () => {
  let app: Elysia;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let merchant: ProvisionedMerchant;
  let other: ProvisionedMerchant;

  beforeAll(async () => {
    db = await createTestDb();
    app = new Elysia()
      .use(errorHandling)
      .use(createContextAuth(db.db))
      .use(createCustomizationModule(db.db));
    merchant = await provisionMerchant(db.db, "Schema Owner");
    other = await provisionMerchant(db.db, "Other Tenant");
  });

  afterAll(async () => {
    await db.close();
  });

  const invoiceSchema = {
    type: "object",
    properties: {
      department: { type: "string", maxLength: 40 },
      cost_center: { type: "string" },
      po_number: { type: "string", pattern: "^PO-[0-9]+$" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      line_items: {
        type: "array",
        items: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } },
      },
      quantity: { type: "integer", minimum: 1 },
    },
    required: ["department", "cost_center"],
  };

  it("PUT /v1/schema/:target creates a schema at version 1", async () => {
    const res = await http(app, "PUT", "/v1/schema/invoice", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: {
        schema: invoiceSchema,
        ui: { department: { label: "Department", placeholder: "e.g. Engineering" } },
      },
    });
    expect(res.status).toBe(200);
    const json = res.json as {
      schema: typeof invoiceSchema;
      ui: { department: { label: string } };
      version: number;
    };
    expect(json.version).toBe(1);
    expect(json.schema.type).toBe("object");
    expect(json.schema.required).toEqual(["department", "cost_center"]);
    expect(json.ui.department.label).toBe("Department");
  });

  it("GET /v1/schema/:target returns the SDK auto-render contract", async () => {
    const res = await http(app, "GET", "/v1/schema/invoice", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(res.status).toBe(200);
    const json = res.json as { schema: { type: string }; ui?: unknown; version: number };
    expect(json.version).toBe(1);
    expect(json.schema.type).toBe("object");
  });

  it("GET an unset target returns 404", async () => {
    const res = await http(app, "GET", "/v1/schema/customer", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(res.status).toBe(404);
    expect((res.json as { code: string }).code).toBe("resource_not_found");
  });

  it("PUT again without If-Match returns 409", async () => {
    const put = await http(app, "PUT", "/v1/schema/invoice", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { schema: invoiceSchema },
    });
    expect(put.status).toBe(409);
    expect((put.json as { code: string }).code).toBe("conflict");
  });

  it("PUT with a wrong If-Match returns 409", async () => {
    const put = await http(app, "PUT", "/v1/schema/invoice", {
      headers: { authorization: `Bearer ${merchant.skTest}`, "if-match": "99" },
      body: { schema: invoiceSchema },
    });
    expect(put.status).toBe(409);
    expect((put.json as { code: string }).code).toBe("conflict");
  });

  it("PUT with the correct If-Match bumps the version to 2", async () => {
    const put = await http(app, "PUT", "/v1/schema/invoice", {
      headers: { authorization: `Bearer ${merchant.skTest}`, "if-match": "1" },
      body: { schema: { ...invoiceSchema, required: ["department"] }, ui: {} },
    });
    expect(put.status).toBe(200);
    const json = put.json as { version: number; schema: { required: string[] } };
    expect(json.version).toBe(2);
    expect(json.schema.required).toEqual(["department"]);
  });

  it("PUT is idempotent under a repeating Idempotency-Key", async () => {
    const headers = {
      authorization: `Bearer ${merchant.skTest}`,
      "idempotency-key": "req-schema-invoice-1",
    };
    const body = { schema: invoiceSchema };
    const first = await http(app, "PUT", "/v1/schema/refunds", { headers, body });
    const second = await http(app, "PUT", "/v1/schema/refunds", { headers, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.json as { version: number }).version).toBe(
      (first.json as { version: number }).version,
    );
  });

  it("DELETE removes the definition; subsequent GET → 404", async () => {
    const del = await http(app, "DELETE", "/v1/schema/refunds", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect([200, 204]).toContain(del.status);

    const got = await http(app, "GET", "/v1/schema/refunds", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(404);
  });

  it("validator: conforming metadata has no errors", async () => {
    const res = await http(app, "PUT", "/v1/schema/vendor", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: {
        schema: {
          type: "object",
          properties: {
            tier: { type: "string", enum: ["gold", "silver"] },
            active: { type: "boolean" },
          },
          required: ["tier"],
        },
      },
    });
    expect(res.status).toBe(200);

    const { validateMetadata } = await import("../../src/modules/customization/validator");
    const problems = await validateMetadata(
      db.db,
      "vendor",
      { merchantId: merchant.merchantId, environment: "test" },
      { tier: "gold", active: true },
    );
    expect(problems).toEqual([]);
  });

  it("validator: rejects non-conforming metadata with field-level errors", async () => {
    const { validateMetadata } = await import("../../src/modules/customization/validator");
    let captured: { code: string; errors?: Array<{ field: string; message: string }> } | null =
      null;
    try {
      await validateMetadata(
        db.db,
        "vendor",
        { merchantId: merchant.merchantId, environment: "test" },
        {
          tier: "platinum", // enum violation
          active: "yes", // wrong type
        },
      );
    } catch (e) {
      captured = e as typeof captured;
    }
    expect(captured).not.toBeNull();
    expect(captured!.code).toBe("validation_error");
    expect(captured!.errors!.length).toBeGreaterThanOrEqual(2);
    const fields = captured!.errors!.map((e) => e.field);
    expect(fields).toContain("$.tier");
    expect(fields).toContain("$.active");
  });

  it("validator: parenthesised required-missing is reported", async () => {
    const { validateMetadata } = await import("../../src/modules/customization/validator");
    let errors: { field: string; message: string }[] = [];
    try {
      await validateMetadata(
        db.db,
        "vendor",
        { merchantId: merchant.merchantId, environment: "test" },
        {
          active: true,
        },
      );
    } catch (e) {
      errors = (e as { errors?: Array<{ field: string; message: string }> }).errors ?? [];
    }
    expect(errors.map((e) => e.field)).toContain("$.tier");
  });

  it("theme PUT/GET roundtrip with defaults", async () => {
    const put = await http(app, "PUT", "/v1/theme", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: {
        primary_color: "#ff6600",
        radius: "12px",
        dark_mode: true,
        branding: { name: "BH Co", locale: "ar" },
      },
    });
    expect(put.status).toBe(200);
    expect((put.json as { primary_color: string }).primary_color).toBe("#ff6600");
    expect((put.json as { dark_mode: boolean }).dark_mode).toBe(true);

    const got = await http(app, "GET", "/v1/theme", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(200);
    const json = got.json as {
      primary_color: string;
      radius: string;
      dark_mode: boolean;
      branding: { name: string };
    };
    expect(json.primary_color).toBe("#ff6600");
    expect(json.radius).toBe("12px");
    expect(json.dark_mode).toBe(true);
    expect(json.branding.name).toBe("BH Co");
  });

  it("theme GET returns a sensible default when unset", async () => {
    const got = await http(app, "GET", "/v1/theme", {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(got.status).toBe(200);
    const json = got.json as { primary_color: string; dark_mode: boolean };
    expect(typeof json.primary_color).toBe("string");
    expect(json.dark_mode).toBe(false);
  });

  it("cross-tenant GET of a defined schema → 404 (tenancy isolation)", async () => {
    const res = await http(app, "GET", "/v1/schema/invoice", {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(res.status).toBe(404);
  });

  it("cross-tenant theme is isolated (defaults, not merchant A's)", async () => {
    const res = await http(app, "GET", "/v1/theme", {
      headers: { authorization: `Bearer ${merchant.skLive}` },
    });
    // merchant A configured test only; live scope is untouched → defaults.
    expect(res.status).toBe(200);
    expect((res.json as { primary_color: string }).primary_color).not.toBe("#ff6600");
  });
});
