-- ============================================================================
-- tie-payments core platform schema (F0 persistence + tenancy)
--
-- Assembled from the T01/T05–T09 wayfinder design blocks plus the F0 tables
-- (tenant, api_key, payment, idempotency). Idempotent (IF NOT EXISTS), SCHEMAFULL.
--
-- Tenancy model (map decision): every business table is scoped by `merchant` +
-- `environment`. The PERMISSIONS clauses below encode the intended DB row-level
-- isolation (WHERE merchant = $auth.merchant AND environment = $auth.environment).
--
-- NOTE (v3.2.4 adaptation): on the SurrealDB nightly build currently shipped by
-- `surrealdb:latest`, write permissions (create/update/delete) are NOT enforced
-- for record-user sessions while read (select) row-filtering IS. F0 therefore
-- enforces tenancy in the Bun store layer (every query binds merchant +
-- environment derived from the API key, never from the body). The PERMISSIONS
-- clauses are retained verbatim as defense-in-depth for a fixed server release.
--
-- Record-id convention: the `id` field is implicit (v3 rejects
-- `DEFINE FIELD id ... TYPE record<...>`). App-generated ids win when the caller
-- supplies one (`payment:pay_<uuid>`); otherwise SurrealDB mints a random id.
-- Money is minor-units `int` (BHD exponent = 3) — never float.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- tenant — deployment/control-plane registry (map: per-tenant DB / region).
-- System-only table; provisioned by the platform, never by merchant code.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS tenant SCHEMAFULL
  PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS name       ON tenant TYPE string;
DEFINE FIELD IF NOT EXISTS region     ON tenant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS instance   ON tenant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS database   ON tenant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status     ON tenant TYPE string DEFAULT 'active';
DEFINE FIELD IF NOT EXISTS created_at ON tenant TYPE datetime DEFAULT time::now();

-- ---------------------------------------------------------------------------
-- merchant — the tenancy principal (links a Better Auth identity).
-- Spans test + live: its PERMISSIONS gate on id, not environment.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS merchant SCHEMAFULL
  PERMISSIONS FOR select, update WHERE id = $auth.merchant;
DEFINE FIELD IF NOT EXISTS auth_user        ON merchant TYPE option<record<user>>;
DEFINE FIELD IF NOT EXISTS tenant           ON merchant TYPE option<record<tenant>>;
DEFINE FIELD IF NOT EXISTS name             ON merchant TYPE string;
DEFINE FIELD IF NOT EXISTS tin              ON merchant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS default_currency ON merchant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS settings         ON merchant TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at       ON merchant TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS merchant_auth_user ON merchant FIELDS auth_user UNIQUE;

-- ---------------------------------------------------------------------------
-- api_key — hash-only storage, environment from prefix, sk|pk role (T08).
-- Raw secrets never touch the DB; `hash` is the SHA-256 of the secret.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS api_key SCHEMAFULL
  PERMISSIONS FOR select, create, update WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS id          ON api_key TYPE string;
DEFINE FIELD IF NOT EXISTS merchant    ON api_key TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment ON api_key TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS role        ON api_key TYPE string ASSERT $value IN ["sk", "pk"];
DEFINE FIELD IF NOT EXISTS prefix      ON api_key TYPE string;
DEFINE FIELD IF NOT EXISTS hash        ON api_key TYPE string;
DEFINE FIELD IF NOT EXISTS active      ON api_key TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS created_at  ON api_key TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS rotated_at  ON api_key TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS api_key_hash  ON api_key FIELDS hash UNIQUE;
DEFINE INDEX IF NOT EXISTS api_key_scope ON api_key FIELDS merchant, environment, active;

-- ---------------------------------------------------------------------------
-- customer — referenced by payment / invoice / subscription.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS customer SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant       ON customer TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment    ON customer TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS email          ON customer TYPE option<string>;
DEFINE FIELD IF NOT EXISTS name           ON customer TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reference      ON customer TYPE option<string>;
DEFINE FIELD IF NOT EXISTS credit_balance ON customer TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS metadata       ON customer TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at     ON customer TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS customer_scope ON customer FIELDS merchant, environment;

-- ---------------------------------------------------------------------------
-- payment_method — token only, PCI SAQ A: never PAN/CVV (T01/T02).
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS payment_method SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant      ON payment_method TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment   ON payment_method TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS customer      ON payment_method TYPE option<record<customer>>;
DEFINE FIELD IF NOT EXISTS gateway       ON payment_method TYPE string;
DEFINE FIELD IF NOT EXISTS unified_token ON payment_method TYPE option<string>;
DEFINE FIELD IF NOT EXISTS brand         ON payment_method TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last4         ON payment_method TYPE option<string>;
DEFINE FIELD IF NOT EXISTS is_default    ON payment_method TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS metadata      ON payment_method TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS pm_scope_customer ON payment_method FIELDS merchant, environment, customer;

-- ---------------------------------------------------------------------------
-- routing_rule — smart routing (map decision): ordered rules + driver
-- failover chain; unmatched requests fall back to the merchant default driver.
-- NOTE: the design doc's selector key is `if`, but `if` is a reserved keyword
-- (not usable even backticked as a field name) — stored as `conditions`.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS routing_rule SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant    ON routing_rule TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment ON routing_rule TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS position    ON routing_rule TYPE int;
DEFINE FIELD IF NOT EXISTS conditions  ON routing_rule TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS driver      ON routing_rule TYPE string;
DEFINE FIELD IF NOT EXISTS failover    ON routing_rule TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS active      ON routing_rule TYPE bool DEFAULT true;
DEFINE INDEX IF NOT EXISTS routing_rule_scope ON routing_rule FIELDS merchant, environment, position;

-- ---------------------------------------------------------------------------
-- payment — the payment aggregate (Payments pillar).
-- id is app-supplied (`pay_<uuid>`); status follows PaymentResource.
-- `idempotency_key` holds the namespaced key (merchant+env+route+key) and its
-- UNIQUE index is the duplicate guard (T01); the claim/commit lifecycle lives
-- in the `idempotency` table below.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS payment SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant           ON payment TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment        ON payment TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS customer           ON payment TYPE option<record<customer>>;
DEFINE FIELD IF NOT EXISTS amount_minor       ON payment TYPE int;
DEFINE FIELD IF NOT EXISTS currency           ON payment TYPE string;
DEFINE FIELD IF NOT EXISTS status             ON payment TYPE string ASSERT $value IN ["requires_action", "processing", "succeeded", "failed", "refunded"];
DEFINE FIELD IF NOT EXISTS action             ON payment TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS provider_reference ON payment TYPE option<string>;
DEFINE FIELD IF NOT EXISTS idempotency_key    ON payment TYPE option<string>;
DEFINE FIELD IF NOT EXISTS metadata           ON payment TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at         ON payment TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS payment_idempotency ON payment FIELDS merchant, environment, idempotency_key UNIQUE;
DEFINE INDEX IF NOT EXISTS payment_scope        ON payment FIELDS merchant, environment, status;

-- ---------------------------------------------------------------------------
-- idempotency — Idempotency-Key claim/commit lifecycle (T01).
-- `claim` inserts an in_progress row (UNIQUE gate on merchant+env+key);
-- `commit` marks it completed with the cached response; a replay after restart
-- returns the committed response. Expired in_progress rows can be re-claimed.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS idempotency SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant        ON idempotency TYPE record<merchant>;
DEFINE FIELD IF NOT EXISTS environment     ON idempotency TYPE string ASSERT $value IN ["test", "live"];
DEFINE FIELD IF NOT EXISTS namespaced_key  ON idempotency TYPE string;
DEFINE FIELD IF NOT EXISTS status          ON idempotency TYPE string ASSERT $value IN ["in_progress", "completed"];
DEFINE FIELD IF NOT EXISTS response_status ON idempotency TYPE option<int>;
DEFINE FIELD IF NOT EXISTS response_headers ON idempotency TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS response_body   ON idempotency TYPE option<string>;
DEFINE FIELD IF NOT EXISTS expires_at      ON idempotency TYPE datetime;
DEFINE FIELD IF NOT EXISTS created_at      ON idempotency TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS idempotency_scope ON idempotency FIELDS merchant, environment, namespaced_key UNIQUE;

-- ---------------------------------------------------------------------------
-- invoice — T05 block (Stripe-mapped lifecycle, minor-units int money)
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS invoice SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant           ON invoice TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment        ON invoice TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS customer           ON invoice TYPE record<customer>;
DEFINE FIELD IF NOT EXISTS status             ON invoice TYPE string ASSERT $value IN ["draft", "open", "paid", "voided", "uncollectible"];
DEFINE FIELD IF NOT EXISTS number             ON invoice TYPE option<string>;
DEFINE FIELD IF NOT EXISTS currency           ON invoice TYPE string;
DEFINE FIELD IF NOT EXISTS collection_method  ON invoice TYPE string ASSERT $value IN ["send_invoice", "charge_automatically"];
DEFINE FIELD IF NOT EXISTS amount_subtotal    ON invoice TYPE int;
DEFINE FIELD IF NOT EXISTS amount_discount    ON invoice TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS amount_tax         ON invoice TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS amount_shipment    ON invoice TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS amount_due         ON invoice TYPE int;
DEFINE FIELD IF NOT EXISTS amount_paid        ON invoice TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS amount_remaining   ON invoice TYPE int;
DEFINE FIELD IF NOT EXISTS amount_overpaid    ON invoice TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS due_date           ON invoice TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS issued_at          ON invoice TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS hosted_invoice_url ON invoice TYPE option<string>;
DEFINE FIELD IF NOT EXISTS invoice_pdf        ON invoice TYPE option<string>;
DEFINE FIELD IF NOT EXISTS line_items         ON invoice TYPE array<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS line_items.*.description  ON invoice TYPE string;
DEFINE FIELD IF NOT EXISTS line_items.*.quantity     ON invoice TYPE decimal;
DEFINE FIELD IF NOT EXISTS line_items.*.unit_price   ON invoice TYPE int;
DEFINE FIELD IF NOT EXISTS line_items.*.subtotal     ON invoice TYPE int;
DEFINE FIELD IF NOT EXISTS line_items.*.discountable ON invoice TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS status_transitions ON invoice TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS metadata           ON invoice TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS invoice_scope_status  ON invoice FIELDS merchant, environment, status;
DEFINE INDEX IF NOT EXISTS invoice_scope_customer ON invoice FIELDS merchant, environment, customer;
DEFINE INDEX IF NOT EXISTS invoice_scope_due     ON invoice FIELDS merchant, environment, due_date;

-- ---------------------------------------------------------------------------
-- invoice_tax_rate — explicit tax rates (seed BH 5% VAT); read-mostly (T05)
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS invoice_tax_rate SCHEMAFULL
  PERMISSIONS FOR select WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant    ON invoice_tax_rate TYPE record<merchant>;
DEFINE FIELD IF NOT EXISTS environment ON invoice_tax_rate TYPE string ASSERT $value IN ["test", "live"];
DEFINE FIELD IF NOT EXISTS name        ON invoice_tax_rate TYPE string;
DEFINE FIELD IF NOT EXISTS percentage  ON invoice_tax_rate TYPE decimal;
DEFINE FIELD IF NOT EXISTS inclusive   ON invoice_tax_rate TYPE bool;
DEFINE FIELD IF NOT EXISTS jurisdiction ON invoice_tax_rate TYPE string;
DEFINE FIELD IF NOT EXISTS tin         ON invoice_tax_rate TYPE option<string>;
DEFINE INDEX IF NOT EXISTS invoice_tax_rate_scope ON invoice_tax_rate FIELDS merchant, environment;

-- ---------------------------------------------------------------------------
-- price — T06 billing_scheme (per_unit / metered / tiered in one mechanism)
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS price SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant        ON price TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment     ON price TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS nickname        ON price TYPE option<string>;
DEFINE FIELD IF NOT EXISTS currency        ON price TYPE string;
DEFINE FIELD IF NOT EXISTS billing_scheme  ON price TYPE string ASSERT $value IN ["per_unit", "metered", "tiered"];
DEFINE FIELD IF NOT EXISTS unit_amount     ON price TYPE option<int>;
DEFINE FIELD IF NOT EXISTS tiered          ON price TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS period          ON price TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS period.interval ON price TYPE string ASSERT $value IN ["day", "week", "month", "year"];
DEFINE FIELD IF NOT EXISTS period.interval_count ON price TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS active          ON price TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS metadata        ON price TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS price_scope_currency ON price FIELDS merchant, environment, currency;

-- ---------------------------------------------------------------------------
-- subscription — T06 (Stripe-mapped lifecycle + dunning)
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS subscription SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant        ON subscription TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment     ON subscription TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS customer        ON subscription TYPE record<customer>;
DEFINE FIELD IF NOT EXISTS status          ON subscription TYPE string ASSERT $value IN ["trialing", "active", "past_due", "incomplete", "canceled"];
DEFINE FIELD IF NOT EXISTS collection_method ON subscription TYPE string ASSERT $value IN ["send_invoice", "charge_automatically"] DEFAULT "charge_automatically";
DEFINE FIELD IF NOT EXISTS items           ON subscription TYPE array<record<subscription_item>>;
DEFINE FIELD IF NOT EXISTS billing_cycle_anchor ON subscription TYPE datetime;
DEFINE FIELD IF NOT EXISTS current_period_start ON subscription TYPE datetime;
DEFINE FIELD IF NOT EXISTS current_period_end   ON subscription TYPE datetime;
DEFINE FIELD IF NOT EXISTS trial_end       ON subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cancel_at       ON subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cancel_at_period_end ON subscription TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS canceled_at     ON subscription TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS default_payment_method ON subscription TYPE option<record<payment_method>>;
DEFINE FIELD IF NOT EXISTS proration_behavior ON subscription TYPE string ASSERT $value IN ["create_prorations", "always_invoice", "none"] DEFAULT "create_prorations";
DEFINE FIELD IF NOT EXISTS status_transitions ON subscription TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS metadata        ON subscription TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS sub_scope_status     ON subscription FIELDS merchant, environment, status;
DEFINE INDEX IF NOT EXISTS sub_scope_customer   ON subscription FIELDS merchant, environment, customer;
DEFINE INDEX IF NOT EXISTS sub_scope_period_end ON subscription FIELDS merchant, environment, current_period_end;

DEFINE TABLE IF NOT EXISTS subscription_item SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant       ON subscription_item TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment    ON subscription_item TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS subscription   ON subscription_item TYPE record<subscription>;
DEFINE FIELD IF NOT EXISTS price          ON subscription_item TYPE record<price>;
DEFINE FIELD IF NOT EXISTS quantity       ON subscription_item TYPE int;
DEFINE FIELD IF NOT EXISTS tax_rates      ON subscription_item TYPE option<array<record<invoice_tax_rate>>>;
DEFINE FIELD IF NOT EXISTS period_start   ON subscription_item TYPE datetime;
DEFINE FIELD IF NOT EXISTS period_end     ON subscription_item TYPE datetime;

DEFINE TABLE IF NOT EXISTS usage_record SCHEMAFULL
  PERMISSIONS FOR select, create WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant          ON usage_record TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment       ON usage_record TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS subscription_item ON usage_record TYPE record<subscription_item>;
DEFINE FIELD IF NOT EXISTS quantity          ON usage_record TYPE int;
DEFINE FIELD IF NOT EXISTS recorded_at       ON usage_record TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS usage_item_time   ON usage_record FIELDS subscription_item, recorded_at;

DEFINE TABLE IF NOT EXISTS dunning_attempt SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant     ON dunning_attempt TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment  ON dunning_attempt TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS subscription ON dunning_attempt TYPE record<subscription>;
DEFINE FIELD IF NOT EXISTS attempt      ON dunning_attempt TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS max_attempts ON dunning_attempt TYPE int DEFAULT 3;
DEFINE FIELD IF NOT EXISTS due_at       ON dunning_attempt TYPE datetime;
DEFINE FIELD IF NOT EXISTS state        ON dunning_attempt TYPE string ASSERT $value IN ["pending", "past_due", "canceled"];

-- ---------------------------------------------------------------------------
-- T07 — durable event log + webhook dispatch (dangling record<event> fixed)
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS outbox_event SCHEMAFULL
  PERMISSIONS FOR select, create WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant     ON outbox_event TYPE record<merchant>;
DEFINE FIELD IF NOT EXISTS environment  ON outbox_event TYPE string ASSERT $value IN ["test", "live"];
DEFINE FIELD IF NOT EXISTS type         ON outbox_event TYPE string;
DEFINE FIELD IF NOT EXISTS object_type  ON outbox_event TYPE string;
DEFINE FIELD IF NOT EXISTS object_id    ON outbox_event TYPE string;
DEFINE FIELD IF NOT EXISTS object       ON outbox_event TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at   ON outbox_event TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS window       ON outbox_event TYPE datetime;
DEFINE INDEX IF NOT EXISTS outbox_created ON outbox_event FIELDS merchant, environment, created_at;

DEFINE TABLE IF NOT EXISTS event_delivery SCHEMAFULL
  PERMISSIONS FOR select WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant       ON event_delivery TYPE record<merchant>;
DEFINE FIELD IF NOT EXISTS environment    ON event_delivery TYPE string ASSERT $value IN ["test", "live"];
DEFINE FIELD IF NOT EXISTS event          ON event_delivery TYPE record<outbox_event>;
DEFINE FIELD IF NOT EXISTS endpoint       ON event_delivery TYPE record<webhook_endpoint>;
DEFINE FIELD IF NOT EXISTS attempt        ON event_delivery TYPE int;
DEFINE FIELD IF NOT EXISTS delivered_at   ON event_delivery TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS response_status ON event_delivery TYPE option<int>;
DEFINE FIELD IF NOT EXISTS signature      ON event_delivery TYPE string;
DEFINE FIELD IF NOT EXISTS deadlettered_at ON event_delivery TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS event_delivery_scope ON event_delivery FIELDS merchant, environment;
-- At-least-once per (event, endpoint): one delivery row per pair, `attempt`
-- increments on retry (T07 D5).
DEFINE INDEX IF NOT EXISTS event_delivery_dedup ON event_delivery FIELDS merchant, environment, event, endpoint UNIQUE;

-- ---------------------------------------------------------------------------
-- inbound_webhook — T07 D6: seen gateway webhooks (de-dup + replay no-op).
-- The UNIQUE (merchant, environment, driver, gateway_event_id) key makes a
-- replayed gateway delivery a 200 no-op instead of a re-emitted event.
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS inbound_webhook SCHEMAFULL
  PERMISSIONS FOR select, create WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant           ON inbound_webhook TYPE record<merchant>;
DEFINE FIELD IF NOT EXISTS environment        ON inbound_webhook TYPE string ASSERT $value IN ["test", "live"];
DEFINE FIELD IF NOT EXISTS driver             ON inbound_webhook TYPE string;
DEFINE FIELD IF NOT EXISTS gateway_event_id   ON inbound_webhook TYPE string;
DEFINE FIELD IF NOT EXISTS provider_reference ON inbound_webhook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS canonical_type     ON inbound_webhook TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at         ON inbound_webhook TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS inbound_webhook_dedup ON inbound_webhook FIELDS merchant, environment, driver, gateway_event_id UNIQUE;

DEFINE TABLE IF NOT EXISTS webhook_endpoint SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant     ON webhook_endpoint TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment  ON webhook_endpoint TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS url          ON webhook_endpoint TYPE string;
DEFINE FIELD IF NOT EXISTS secret       ON webhook_endpoint TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enabled      ON webhook_endpoint TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS events       ON webhook_endpoint TYPE array<string>;
DEFINE FIELD IF NOT EXISTS max_attempts ON webhook_endpoint TYPE int DEFAULT 3;
DEFINE FIELD IF NOT EXISTS created_at   ON webhook_endpoint TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS endpoint_scope ON webhook_endpoint FIELDS merchant, environment;

-- ---------------------------------------------------------------------------
-- T09 — dynamic schema engine + theme (custom-field contract + HPP branding)
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS field_schema SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant      ON field_schema TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment   ON field_schema TYPE string ASSERT $value IN ["test", "live"] READONLY;
DEFINE FIELD IF NOT EXISTS target_entity ON field_schema TYPE string;
DEFINE FIELD IF NOT EXISTS schema        ON field_schema TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS ui            ON field_schema TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS version       ON field_schema TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS updated_at    ON field_schema TYPE datetime;
DEFINE INDEX IF NOT EXISTS field_schema_scope ON field_schema FIELDS merchant, environment, target_entity UNIQUE;

DEFINE TABLE IF NOT EXISTS theme SCHEMAFULL
  PERMISSIONS FOR select, create, update WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD IF NOT EXISTS merchant      ON theme TYPE record<merchant> READONLY;
DEFINE FIELD IF NOT EXISTS environment   ON theme TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS primary_color ON theme TYPE string;
DEFINE FIELD IF NOT EXISTS radius        ON theme TYPE string;
DEFINE FIELD IF NOT EXISTS dark_mode     ON theme TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS css           ON theme TYPE option<string>;
DEFINE FIELD IF NOT EXISTS branding      ON theme TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS theme_scope   ON theme FIELDS merchant, environment;
