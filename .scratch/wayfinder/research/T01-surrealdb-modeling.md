# T01 — SurrealDB modeling for the payments domain

Research ticket. **Research only — no product code.** Findings grounded in current
SurrealDB docs (fetched via Context7 on 2026-08-05). Verified against `SPEC.md`
(environment enum `test|live`, invoice lifecycle `draft → issued → partially_paid →
paid → voided/overdue`, metadata `->>'po_number'` custom fields, idempotency keys,
webhook outbox).

Key SurrealDB conceptual primitives used throughout:
- **`SCHEMAFULL`** = add a `DEFINE TABLE ... SCHEMAFULL` and per-field types via `DEFINE FIELD` → validated, relational-ish, JSON-schema-like control.
- **`SCHEMALESS`** = free-form records, nothing validated; good for the token/event payload bags.
- **Record link** = `TYPE record<other_table>` (a single record pointer) or `option<record<T>>` for nullable.
- **Record SET** = `SET<record<T>>` / `array<record<T>>` (one-to-many stored inline).
- **`TYPE object FLEXIBLE`** = an object whose keys/values are unconstrained (belly of the custom-fields engine).
- **`ASSERT`** on a field = validation predicate; SurrealDB's substitute for an enum + business constraint.
- **`DEFINE INDEX`** = secondary index; standard B-tree / UNIQUE / FULLTEXT / MTREE.
- **`decimal`** type = arbitrary-point decimal for money (never `float`).
- **Record IDs**: `record:ulid()` / `record:uuid()` / `rand()`; ULID is lexicographically sortable.

---

## Findings

### 1. Table/modeling syntax for each core entity

SurrealDB has no SQL `CREATE TABLE ... (cols)` — you define a table kind, then
declare fields. Sketch of each entity (full runnable block in the schema section below):

- **merchant** — the tenant root. SCHEMAFULL. Fields: name, api keys (test/live),
  HMAC webhook secret, default currency, settings object (FLEXIBLE). Every other
  table links back to it via `record<merchant>`.
- **customer** — SCHEMAFULL. `merchant: record<merchant>`, `environment`,
  profile line items, and `metadata object FLEXIBLE`. A customer belongs to exactly
  one merchant and one environment.
- **payment_method / token** — SCHEMAFULL. Cross-gateway: store one row per
  gateway token, map to the unified `customer`. Fields: `customer: record<customer>`,
  `gateway`, `gateway_token`, `brand`, `last4`, `expiry`, `is_default`. Because the
  value comes *from* the gateway (which already did the PCI work), store the leased
  token string — never PAN/CVV (keep SAQ A/A-EP).
- **payment / transaction** — SCHEMAFULL. `merchant`, `customer`, `invoice`
  (optional link), `environment`, `amount: decimal`, `currency`, `status`, gateway
  refs, and `idempotency_key`. This is a ledger row.
- **invoice** — SCHEMAFULL. `merchant`, `customer`, `status`, totals (decimal),
  line items (`array<object> FLEXIBLE`), VAT/TIN, `environment`, `metadata
  object FLEXIBLE`, `overdue_at`. Lifecycle = `status` + `ASSERT` (see §5).
- **subscription** — SCHEMAFULL. `merchant`, `customer`, plan/price refs,
  `schedule` (cron/interval object), `status`, `current_period_start/end`,
  `dunning_attempts`. Links to a plan table for flat/seat/usage/tiered pricing.
- **webhook_event / webhook_delivery** — SCHEMAFULL. The outbox. `merchant`,
  `environment`, `event_type`, `payload` (SCHEMALESS-ish / object FLEXIBLE),
  `status (pending/queued/sent/failed)`, `attempts`, `next_retry_at`,
  `signature`. Written atomically in the same transaction as the domain change (see §4, §6).

**Field typing decisions (from docs):**
- Literally every tenant-scoped table carries the **same two scoping columns**
  (`merchant: record<merchant>` + `environment`) — a deliberate convention so a
  single composable `WHERE merchant = $m AND environment = $e` applies everywhere (see §3).
- Nullable relational pointers: `TYPE option<record<T>>` (e.g. invoice_id on a payment).
- One-to-many inline: `SET<record<T>>` for small, always-read collections; use a
  separate table + record link for large/growable ones.
- Nested field types via dot notation: `DEFINE FIELD line_items.*.amount ON invoice TYPE decimal;`
  (docs: fields-and-validation).
- Custom field bag: `DEFINE FIELD metadata ON invoice TYPE object FLEXIBLE;` (docs: define-a-schema).

Sources:
- tables: https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/tables
- fields & validation (record link, nested, option, ASSERT): https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/fields-and-validation
- FLEXIBLE object: https://surrealdb.com/docs/surrealdb/explore/tutorials/define-a-schema
- DEFINE FILE/TABLE / relation tables + permissions: https://surrealdb.com/docs/surrealdb/reference/query-language/statements/define/table
- record links vs graph relations (when to prefer record links): https://surrealdb.com/docs/surrealdb/learn/data-models/graph/record-links-vs-graph-relations

### 2. Extensible metadata / custom fields + querying by dynamic field

Two viable models; the SPEC's `metadata->>'po_number'` requirement maps to dot-notation
in SurrealQL, **plus** he asserts "without schema migration".

**(a) Inline FLEXIBLE object per entity (recommended for the "attach arbitrary KV,
no migration" ask):**
```
DEFINE FIELD metadata ON invoice TYPE object FLEXIBLE;
```
- Write any key/value: `UPDATE invoice:abc SET metadata.po_number = 'PO-4021';`
- Read / filter by a dynamic key with dot-notation or safe idiom `.?`:
  ```surql
  SELECT * FROM invoice WHERE metadata.po_number = 'PO-4021';
  SELECT metadata.?(po_number) FROM invoice;      -- safely; returns NONE if absent
  SELECT object::get(metadata, $key) FROM invoice; -- dynamic-by-value lookup
  ```
- Docs idioms / select: https://surrealdb.com/docs/surrealdb/reference/query-language/language-primitives/idioms , https://surrealdb.com/docs/surrealdb/reference/query-language/statements/select

**Indexing dynamic fields for fast lookup.** Yes — you can index a nested object field:
```
DEFINE INDEX invoice_metadata_po_number ON invoice FIELDS metadata.po_number;
```
(docs: index-types-and-strategies — standard B-tree index, FIELDS, plus UNIQUE variant).
Constraint / gotcha:
- An index must be **named per field path** (`metadata.po_number`); SurrealDB does not
  auto-index unknown new keys. So "arbitrary key, auto-fast" is not free.
- **Recommended split:**
  1. Precondition the handful of hot / filterable custom keys (e.g. `po_number`,
     `cost_center`) by `DEFINE INDEX` per key (additive — still no destructive migration).
  2. For truly arbitrary EAV it's better to model a side table
     `entity_custom_field (entity_kind, entity_id, key, value_indexable)` with a normal /
     FULLTEXT index on `value` and `key` — this gives one indexed mechanism that works
     for any key without per-key `DEFINE INDEX`.
- FULLTEXT of dynamic values: `DEFINE INDEX ... FIELDS ... FULLTEXT ANALYZER ...` lets you
  `WHERE metadata.notes @@ 'urgent'` (docs: index-types-and-strategies, full-text tutorial).
  Useful for searching arbitrary metadata text across a tenant.

Net answer: dynamic KV **without schema migration** = `object FLEXIBLE`; **fast lookup** =
pre-declared `DEFINE INDEX` on the specific nested path(s) you need to filter on, or an
EAV side table for unlimited arbitrary fields. No Postgres-style `->>` operator exists;
the idiom operators (`.` / `.?`) are the direct equivalent.

Sources:
- FLEXIBLE objects: https://surrealdb.com/docs/surrealdb/explore/tutorials/define-a-schema
- nested-field typing + indexing paths: https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/fields-and-validation
- index types (B-tree/UNIQUE/FULLTEXT/BM25/MTREE): https://surrealdb.com/docs/surrealdb/learn/schema-management/indexes/index-types-and-strategies
- full-text search indexes: https://surrealdb.com/docs/surrealdb/learn/data-models/full-text-search/search-indexes
- safe nested access (`.?`, object::get): https://surrealdb.com/docs/surrealdb/reference/query-language/language-primitives/idioms

### 3. Multi-tenant isolation per merchant + `environment` (test|live) scoping

Three supported shapes, in increasing isolation:

1. **Per-tenant (or per-environment) database/namespace** — strongest isolation;
   each tenant gets its own namespace+database via `db.use_ns(x).use_db(y)`, or in
   the managed Spectron product a Context per tenant with `scope_floor = {org: tenant_id}`.
   - Recommended: fold `environment` into the **database name** (`tie` ns → `db: acme-live`,
     `acme-test`, …). Zero-leak by construction, satisfies "test never touches live", and
     the environment clause disappears from every query.
   - Cost: per-tenant DBs add operational overhead and forbid cheap cross-tenant analytics;
     best when merchants are few and large, or compliance forces physical separation.
2. **Shared schema + tenant_id/environment columns + scoped WHERE** — the SPEC's described
   model (`WHERE environment = req.environment`). All rows carry `merchant` + `environment`.
   Query-time filtering is the mechanism; enforce it systematically:
   - **Composite indexes** fronted on `(merchant, environment, ...)` on every hot query.
   - Defense-in-depth: in-DB **record-level PERMISSIONS** — constrain
     `FOR SELECT/UPDATE/DELETE WHERE merchant = $auth.merchant AND environment = $auth.environment`
     so a session/`$auth` scope physically cannot read another tenant (docs: define/table, authenticating-users).
3. **Composite UNIQUE indexes include merchant+environment** — critical so uniqueness is
   tenant-local: idempotency keys, api key values, webhook secrets, customer refs must be
   unique *per (merchant, environment)*, not globally (docs: index-types-and-strategies — composite unique).

**Recommendation for this platform:** shared schema (model 2) with a strict column
convention (`merchant` + `environment` on every scoped table), active row-level
`PERMISSIONS` scoping by `$auth`, composite unique keys that include the two scope
columns, and front-end indexes on `(merchant, environment)`. Optionally split *environments*
into separate physical databases (model-1) for a hard live/test boundary — cheap (only two
DBs), and removes the `environment` filter from inner queries. Do **not** create one DB per
merchant unless a compliance requirement demands it — it kills cross-tenant tooling.

Note: the tighter "scope floor / record-level" guarantees in the fetched docs are the
Spectron managed offering; in self-hosted open-source SurrealDB the equivalent is
`PERMISSIONS` on tables + namespacing them with a verified `merchant`/`environment` predicate.

Sources:
- PERMISSIONS + relation table constraining by ownership: https://surrealdb.com/docs/surrealdb/reference/query-language/statements/define/table
- `$auth`-scoped PERMISSIONS example: https://surrealdb.com/docs/surrealdb/reference/rust/concepts/authenticating-users
- multi-DB tenancy (use_ns/use_db per tenant): https://surrealdb.com/docs/surrealdb/reference/rust/concepts/multi-tenancy
- managed multi-tenancy (Contexts, scope floors, patterns): https://surrealdb.com/docs/surrealdb/spectron/self-hosting/security/multi-tenancy

### 4. Transactions / atomicity / consistency for money-moving writes

- **Multi-statement queries are atomic when wrapped explicitly.** Use
  `BEGIN TRANSACTION; ... COMMIT TRANSACTION;` — if any statement fails the whole
  transaction rolls back.
- **Sending BEGIN…COMMIT in one request is the recommended HTTP pattern** — the docs
  `transaction_multi()` wraps a statement list in BEGIN/COMMIT and sends as a single
  atomic query on any transport; same idea in JS: `beginTransaction() → … → commit()`, or
  `cancel()` on error.
- **Grain of atomicity:** one `.query()`/request that contains several `;` statements is
  atomic; *separate* HTTP requests are NOT automatically grouped. For money-moving flows
  (e.g. create payment → update invoice status → insert webhook outbox row → increment
  balance) **always** wrap the multi-record write in an explicit transaction. Do not
  assume cross-request atomicity.
- **`DEFINE EVENT` runs inside the triggering transaction** by default (sync), so an
  event that writes the outbox row is atomic with its trigger; use `ASYNC` only when you
  explicitly accept non-atomic side effects to cut write latency (docs: defining-events).
- **Money type:** use `decimal`, not `float` — the docs explicitly state Decimal is for
  accurate financial calc (tax, currency exchange) and that native numbers introduce
  rounding errors (docs: decimal).
- **Consistency caveat:** SurrealDB gives you atomic multi-statement transactions and
  native per-record uniqueness, but it is **not** a classic SQL datastore — there is no
  built-in numeric CHECK/DECIMAL-column arithmetical invariant (e.g. balance int stays in
  sync). Enforce invariants (invoice totals == Σ line items; balance debits) in the
  transaction body with SurrealQL expressions/`ASSERT`, and prefer read-modify-write
  inside the same transaction for counters. (This is a modeling decision, not a doc claim.)

Sources:
- JS transaction handles (create/update/commit/cancel): https://surrealdb.com/docs/surrealdb/reference/javascript/api/core/surreal-transaction
- multi-statement atomic query + transaction_multi over HTTP: https://surrealdb.com/docs/surrealdb/reference/mojo/concepts/transactions
- events run in-transaction & ASYNC option: https://surrealdb.com/docs/surrealdb/learn/schema-management/events-and-triggers/defining-events
- decimal for money: https://surrealdb.com/docs/surrealdb/reference/javascript/api/values/decimal

### 5. State-machine / enum modeling (invoice, subscription status)

- **No native enum type** in SurrealDB. The documented convention is a `string` field with
  an **`ASSERT $value IN [...]`** membership guard:
  ```
  DEFINE FIELD status ON invoice TYPE string
      ASSERT $value IN ["draft","issued","partially_paid","paid","voided","overdue"];
  ```
  Docs' first-party example (`loan`/`repayment` sample schema) does exactly this
  (`status TYPE string ASSERT $value IN ["active","paid","defaulted"]`).
- Reuse a shared allow-list with **`DEFINE PARAM`** to avoid duplication across tables:
  ```
  DEFINE PARAM $INVOICE_STATUSES VALUE ["draft","issued","partially_paid","paid","voided","overdue"];
  DEFINE FIELD status ON invoice TYPE string ASSERT $value IN $INVOICE_STATUSES;
  ```
  (docs: schema-best-practices — DEFINE PARAM + ASSERT; DEFINE FIELD ASSERT/THROW).
- **`ASSERT` enforces value-membership only, not transition legality** (draft may not jump
  straight to paid). There is no DB-enforced edge validator. Two options:
  - Enforce allowed transitions in the **Bun/Elysia domain layer** (recommended — keeps the
    DB simple and the state machine explicit in one place).
  - Optionally add a `DEFINE FUNCTION fn::invoice_transition_ok($from, $to)` returning bool
    and use it in the update's `WHEN`/`ASSERT` if you want DB-side enforcement.
- Subscriptions: same pattern (`string` + `ASSERT $value IN ["active","past_due","canceled",...]`),
  plus `current_period_start/current_period_end` datetimes driven by the scheduler.

Sources:
- first-party enum-via-ASSERT sample schema: https://surrealdb.com/docs/surrealdb/learn/schema-management/schema-design/sample-industry-schemas
- DEFINE PARAM reuse + ASSERT: https://surrealdb.com/docs/surrealdb/learn/schema-management/schema-design/schema-best-practices
- DEFINE FIELD syntax (TYPE/ASSERT/THROW/permissions): https://surrealdb.com/docs/surrealdb/reference/query-language/statements/define/field

### 6. Idempotency keys + webhook outbox / event log

- **Idempotency key storage:** store the client-supplied key on the payment record with a
  **composite UNIQUE index on `(merchant, environment, idempotency_key)`** — so replay from
  the same tenant/env is deduped but the same key is legal across tenants.
  Use **`UPSERT`** (create-or-update in one atomic statement) or `INSERT ... ON DUPLICATE KEY
  UPDATE` — the docs recommend UPSERT against a unique index for exactly this
  "return existing row or create it" reason and call it an *idempotent operation*. Detect a
  duplicate by the rejected insert (unique violation) and return the original result.
- **Outbox / event log (webhook dispatch):** an outbox fits SurrealDB naturally:
  1. In the **same transaction** that mutates the domain row, also `CREATE webhook_delivery`
     with `status = 'pending'` (either explicit statement or a `DEFINE EVENT` that runs
     synchronously in-transaction — docs: defining-events).
  2. A dispatcher worker `SELECT * FROM webhook_delivery WHERE status = 'pending'
     ORDER BY created_at LIMIT N` (indexed by `(status, next_retry_at)`), tries the
     HTTP POST, then updates `status`/`attempts`/`next_retry_at`; retries via
     `WHERE next_retry_at <= time::now()`.
  3. Full audit/replay: keep `payload` (object FLEXIBLE), `signature`, and every attempt
     (`attempts: array<object>`) on the delivery row.
  - `DEFINE EVENT` on `invoice`/`subscription`/`payment` to auto-write the outbox row is the
    cleanest fit (in-transaction → at-least-once without app-side choreography);
    mark the event `ASYNC` if outbox writes shouldn't block the ledger write.
- **Live queries / change feed** (`LIVE SELECT * FROM webhook_delivery WHERE status = 'pending'`)
  can drive a push-style dispatcher instead of polling (docs: live-queries).

Sources:
- UPSERT + unique index idempotency + `ON DUPLICATE KEY UPDATE`: https://surrealdb.com/docs/surrealdb/reference/query-language/statements/upsert , https://surrealdb.com/docs/surrealdb/learn/querying/concepts-and-guides/idempotent-operations , https://surrealdb.com/docs/surrealdb/learn/querying/performance/performance-best-practices
- unique record IDs / duplicate-create error: https://surrealdb.com/docs/surrealdb/reference/query-language/language-primitives/data-types/record-ids
- events → auto-insert in-transaction: https://surrealdb.com/docs/surrealdb/learn/schema-management/events-and-triggers/defining-events
- live queries: https://surrealdb.com/docs/surrealdb/reference/javascript/concepts/live-queries

### 7. Gotchas for a transactional, relational-ish payments workload

- **Record links are pointers, not joins.** SurrealDB resolves them lazily/sneakily;
  a `record<payment>` link stored is cheap, but **reading** several linked hops costs
  extra per-row lookups. Flatten/denormalize **hot read fields onto the child record**
  (e.g. copy `merchant.name`/`merchant.currency` onto `payment` or `invoice` at write time)
  so list views don't N+1. Use `FETCH` deliberately (and sparingly) instead of broad joins.
  Docs recommend *record links for performance* when multi-hop graph queries aren't needed
  and you want explicit ON DELETE control (cascade/refuse/ignore) — good for our payment↔
  invoice↔customer graph. (docs: record-links-vs-graph-relations, select/FETCH.)
- **Indexing nested / FLEXIBLE fields requires a `DEFINE INDEX` per path — it's not free** (§2).
  Decide a priori which custom keys are filterable; everything else goes to an EAV table
  or a cheap `SCHEMALESS` lookup.
- **Unique indexes are the concurrency guard.** UPSERT via a unique index avoids full-table
  scans and is "more performant ... for modifying single records" (docs: performance-best-practices).
  Use it for idempotency and for tenant-unique business keys.
- **Record ID choice matters.** Prefer `record:ulid()` / `record:uuid()` (`ulid()` gives
  sortable IDs so `START n LIMIT k`, cursor pagination, and by-time scans are efficient) over
  bare `rand()`. (docs: record-id-best-practices, tables-and-fields record ids.)
- **Never use `float` for money** — `decimal` or store minor units as int (docs: decimal).
  Decide a single convention (recommend `decimal` for amounts + `int` minor units for exact
  ledger reconciliation) and enforce in `DEFINE FIELD`.
- **Field `READONLY` / `VALUE`** can lock system-managed columns (e.g. `created_at`,
  `environment`) so tenants can't forge their own scope (docs: define/field).
- **Every scoped table must repeat the two scope columns + composite indexes.** A table that
  forgets `merchant`/`environment` silently leaks across tenants. Make it a lint rule /
  reviewed convention.
- **Cross-tenant queries are not a thing in model 2** unless you deliberately omit the
  scope predicate — which is exactly what `PERMISSIONS` + a strict WHERE convention prevents.
- **Atomicity is per-transaction, not per-client-call chain** (§4). Payments + outbox +
  state transitions must travel inside one BEGIN…COMMIT.
- **No native enum / no `->>` JSON operator** (§2, §5) — internalize SurrealDB idiom access
  (`.` / `.?`) and ASSERT-based enums as the platform convention.

---

## Draft schema sketch (SurrealDB definitions)

A working starting point. Notes: `SCHEMAFULL` for business entities, `SCHEMALESS` or
`object FLEXIBLE` for payload bags; scope columns `merchant` + `environment` on every
tenant table; `decimal` for money; composite unique keys scoped by tenant+environment;
`DEFINE PARAM` to share enum lists; metadata as FLEXIBLE object with named indexes for
filtered keys.

```surql
-- Shared enum lists
DEFINE PARAM $INVOICE_STATUSES VALUE ["draft","issued","partially_paid","paid","voided","overdue"];
DEFINE PARAM $SUB_STATUSES     VALUE ["active","trialing","past_due","canceled","paused","expired"];
DEFINE PARAM $PAYMENT_STATUSES VALUE ["pending","processing","succeeded","failed","refunded","partially_refunded","authorized","voided"];
DEFINE PARAM $WEBHOOK_STATUSES VALUE ["pending","queued","sent","failed","retrying"];

---------------------------------------------------------------------
-- Tenant root
DEFINE TABLE merchant SCHEMAFULL
  PERMISSIONS FOR select WHERE id = $auth.merchant;
DEFINE FIELD name            ON merchant TYPE string;
DEFINE FIELD default_currency ON merchant TYPE string;
DEFINE FIELD test_api_key    ON merchant TYPE string;
DEFINE FIELD live_api_key    ON merchant TYPE string;
DEFINE FIELD webhook_secret  ON merchant TYPE string;
DEFINE FIELD settings        ON merchant TYPE object FLEXIBLE;

---------------------------------------------------------------------
-- Customers (per merchant, per environment)
DEFINE TABLE customer SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant;
DEFINE FIELD merchant    ON customer TYPE record<merchant>;
DEFINE FIELD environment ON customer TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD email       ON customer TYPE string ASSERT string::is_email($value);
DEFINE FIELD name        ON customer TYPE string;
DEFINE FIELD reference   ON customer TYPE option<string>;
DEFINE FIELD metadata    ON customer TYPE object FLEXIBLE;
DEFINE INDEX customer_scope_env ON customer FIELDS merchant, environment;
DEFINE INDEX customer_uniq_ref  ON customer FIELDS merchant, environment, reference UNIQUE;

---------------------------------------------------------------------
-- Cross-gateway tokens mapped to a unified customer
DEFINE TABLE payment_method SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant;
DEFINE FIELD merchant       ON payment_method TYPE record<merchant>;
DEFINE FIELD environment    ON payment_method TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD customer       ON payment_method TYPE record<customer>;
DEFINE FIELD gateway        ON payment_method TYPE string;        -- stripe|adyen|benefit|...
DEFINE FIELD gateway_token  ON payment_method TYPE string;        -- leased token only, no PAN/CVV
DEFINE FIELD brand          ON payment_method TYPE option<string>;
DEFINE FIELD last4          ON payment_method TYPE option<string>;
DEFINE FIELD expiry_month   ON payment_method TYPE option<int>;
DEFINE FIELD expiry_year    ON payment_method TYPE option<int>;
DEFINE FIELD is_default     ON payment_method TYPE bool DEFAULT false;
DEFINE INDEX pm_scope_on_customer ON payment_method FIELDS merchant, environment, customer;

---------------------------------------------------------------------
-- Transaction / payment ledger row
DEFINE TABLE payment SCHEMAFULL
  PERMISSIONS FOR select WHERE merchant = $auth.merchant;
DEFINE FIELD id              ON payment TYPE record<payment>;       -- payment:ulid()
DEFINE FIELD merchant        ON payment TYPE record<merchant>;
DEFINE FIELD environment     ON payment TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD customer        ON payment TYPE option<record<customer>>;
DEFINE FIELD invoice         ON payment TYPE option<record<invoice>> ON DELETE SET NULL;
DEFINE FIELD amount          ON payment TYPE decimal;               -- money: NEVER float
DEFINE FIELD currency        ON payment TYPE string;
DEFINE FIELD status          ON payment TYPE string ASSERT $value IN $PAYMENT_STATUSES;
DEFINE FIELD idempotency_key ON payment TYPE option<string>;
DEFINE FIELD gateway_ref     ON payment TYPE option<record<gateway_transaction>>;
DEFINE FIELD created_at      ON payment TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX payment_scope_status ON payment FIELDS merchant, environment, status;
DEFINE INDEX payment_uniq_idempot   ON payment FIELDS merchant, environment, idempotency_key UNIQUE;

---------------------------------------------------------------------
-- Configured gateway / driver connection per merchant+environment
DEFINE TABLE gateway_config SCHEMAFULL;
DEFINE FIELD merchant    ON gateway_config TYPE record<merchant>;
DEFINE FIELD environment ON gateway_config TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD driver      ON gateway_config TYPE string;             -- mock|stripe|benefit|tap|...
DEFINE FIELD credentials ON gateway_config TYPE object FLEXIBLE;    -- secrets: NEVER expose
DEFINE FIELD is_active   ON gateway_config TYPE bool DEFAULT false;

---------------------------------------------------------------------
-- Invoices with lifecycle state machine
DEFINE TABLE invoice SCHEMAFULL
  PERMISSIONS FOR select, update WHERE merchant = $auth.merchant;
DEFINE FIELD id            ON invoice TYPE record<invoice>;          -- invoice:ulid()
DEFINE FIELD merchant      ON invoice TYPE record<merchant>;
DEFINE FIELD environment   ON invoice TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD customer      ON invoice TYPE record<customer>;
DEFINE FIELD status        ON invoice TYPE string ASSERT $value IN $INVOICE_STATUSES;
DEFINE FIELD currency      ON invoice TYPE string;
DEFINE FIELD subtotal      ON invoice TYPE decimal;
DEFINE FIELD vat_rate      ON invoice TYPE decimal;
DEFINE FIELD vat_total     ON invoice TYPE decimal;
DEFINE FIELD total         ON invoice TYPE decimal;
DEFINE FIELD line_items    ON invoice TYPE array<object> FLEXIBLE;   -- each: {desc, qty, unit_price, tax}
DEFINE FIELD line_items.*.amount ON invoice TYPE decimal;
DEFINE FIELD issued_at     ON invoice TYPE option<datetime>;
DEFINE FIELD paid_at       ON invoice TYPE option<datetime>;
DEFINE FIELD overdue_at    ON invoice TYPE datetime;
DEFINE FIELD metadata      ON invoice TYPE object FLEXIBLE;          -- custom fields engine
-- ~ SPEC "metadata->>'po_number'": filterable without destructive migration:
DEFINE INDEX invoice_metadata_po_number ON invoice FIELDS metadata.po_number;
DEFINE INDEX invoice_scope_status       ON invoice FIELDS merchant, environment, status;
DEFINE INDEX invoice_scope_overdue      ON invoice FIELDS merchant, environment, overdue_at;

---------------------------------------------------------------------
-- Subscriptions / recurring billing
DEFINE TABLE subscription SCHEMAFULL
  PERMISSIONS FOR select, update WHERE merchant = $auth.merchant;
DEFINE FIELD id                  ON subscription TYPE record<subscription>;
DEFINE FIELD merchant            ON subscription TYPE record<merchant>;
DEFINE FIELD environment         ON subscription TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD customer            ON subscription TYPE record<customer>;
DEFINE FIELD plan                ON subscription TYPE record<plan>;
DEFINE FIELD status              ON subscription TYPE string ASSERT $value IN $SUB_STATUSES;
DEFINE FIELD schedule            ON subscription TYPE object FLEXIBLE; -- {interval, every_n|cron}
DEFINE FIELD current_period_start ON subscription TYPE datetime;
DEFINE FIELD current_period_end   ON subscription TYPE datetime;
DEFINE FIELD dunning_attempts     ON subscription TYPE int DEFAULT 0;
DEFINE INDEX subscription_scope_status ON subscription FIELDS merchant, environment, status;

DEFINE TABLE plan SCHEMAFULL;
DEFINE FIELD merchant    ON plan TYPE record<merchant>;
DEFINE FIELD environment ON plan TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD pricing_mode ON plan TYPE string ASSERT $value IN ["flat","seat","usage","tiered"];
DEFINE FIELD amount      ON plan TYPE decimal;
DEFINE FIELD currency    ON plan TYPE string;

---------------------------------------------------------------------
-- Webhook outbox: written atomically with domain change, then dispatched
DEFINE TABLE webhook_delivery SCHEMAFULL
  PERMISSIONS FOR select, update WHERE merchant = $auth.merchant;
DEFINE FIELD id           ON webhook_delivery TYPE record<webhook_delivery>;
DEFINE FIELD merchant     ON webhook_delivery TYPE record<merchant>;
DEFINE FIELD environment  ON webhook_delivery TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD event_type   ON webhook_delivery TYPE string;          -- payment.succeeded | invoice.paid | ...
DEFINE FIELD source_table ON webhook_delivery TYPE string;
DEFINE FIELD source_id    ON webhook_delivery TYPE record;          -- polymorphic source
DEFINE FIELD payload      ON webhook_delivery TYPE object FLEXIBLE;
DEFINE FIELD signature    ON webhook_delivery TYPE string;          -- HMAC-SHA256
DEFINE FIELD status       ON webhook_delivery TYPE string ASSERT $value IN $WEBHOOK_STATUSES;
DEFINE FIELD attempts     ON webhook_delivery TYPE array<object> FLEXIBLE; -- {at, http_status, error}
DEFINE FIELD next_retry_at ON webhook_delivery TYPE datetime;
DEFINE INDEX wh_scope_pending ON webhook_delivery FIELDS merchant, environment, status, next_retry_at;

-- Optional: auto-write the outbox row within the domain transaction (at-least-once).
-- DEFINE EVENT invoice_paid_outbox ON invoice
--   WHEN $event = "UPDATE" AND $after.status = "paid" AND $before.status != "paid"
--   THEN ( CREATE webhook_delivery SET ..., payload = $after );
```

**Recommended conventions to lock in:**
- Money = `decimal` everywhere (never `float`); or minor-units `int`. Pick one.
- Scope = `record<merchant>` + `environment["test"|"live"]` on every tenant table + composite
  (UNIQUE) indexes that include both.
- Record IDs = `:ulid()` for sortable, collision-free, cursor-paginable keys.
- Enums = `string` + `ASSERT $value IN $PARAM`; transitions enforced in the Bun/Elysia layer.
- Idempotency = composite UNIQUE `(merchant, environment, idempotency_key)` + `UPSERT`.
- Custom fields = `metadata object FLEXIBLE` + named `DEFINE INDEX` for the keys you filter on
  (or an EAV side table for unlimited arbitrary keys).
- Multi-record writes = explicit `BEGIN/COMMIT TRANSACTION`; outbox event written in the same transaction.

---

## Sources

Fetched live via Context7 (`npx ctx7@latest docs /surrealdb/docs.surrealdb.com ...`) — official docs.surrealdb.com:

- Tables & fields — define schemafull/schemaless: https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/tables
- Fields & validation (record link, option, nested, ASSERT): https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/fields-and-validation
- FLEXIBLE object tutorial: https://surrealdb.com/docs/surrealdb/explore/tutorials/define-a-schema
- DEFINE TABLE (SCHEMAFULL, TYPE RELATION, PERMISSIONS): https://surrealdb.com/docs/surrealdb/reference/query-language/statements/define/table
- DEFINE FIELD (TYPE/FLEXIBLE/ASSERT/THROW/permissions): https://surrealdb.com/docs/surrealdb/reference/query-language/statements/define/field
- Index types & strategies (B-tree / UNIQUE / FULLTEXT / BM25 / MTREE): https://surrealdb.com/docs/surrealdb/learn/schema-management/indexes/index-types-and-strategies
- Full-text search indexes: https://surrealdb.com/docs/surrealdb/learn/data-models/full-text-search/search-indexes
- Record IDs & addressing (ulid/uuid/rand): https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/record-ids-and-addressing
- Record ID best practices (ULID sortable): https://surrealdb.com/docs/surrealdb/learn/schema-management/tables-and-fields/record-id-best-practices
- Idioms / dot & safe nested access: https://surrealdb.com/docs/surrealdb/reference/query-language/language-primitives/idioms
- SELECT nested fields + FETCH: https://surrealdb.com/docs/surrealdb/reference/query-language/statements/select
- FETCH clause: https://surrealdb.com/docs/surrealdb/reference/query-language/clauses/fetch
- Record links vs graph relations: https://surrealdb.com/docs/surrealdb/learn/data-models/graph/record-links-vs-graph-relations
- Schema best practices (DEFINE PARAM): https://surrealdb.com/docs/surrealdb/learn/schema-management/schema-design/schema-best-practices
- Sample industry schemas (enum-via-ASSERT, money): https://surrealdb.com/docs/surrealdb/learn/schema-management/schema-design/sample-industry-schemas
- UPSERT / idempotent operations: https://surrealdb.com/docs/surrealdb/reference/query-language/statements/upsert , https://surrealdb.com/docs/surrealdb/learn/querying/concepts-and-guides/idempotent-operations
- Performance best practices (UPSERT vs scan): https://surrealdb.com/docs/surrealdb/learn/querying/performance/performance-best-practices
- Record IDs data type (duplicate-create error): https://surrealdb.com/docs/surrealdb/reference/query-language/language-primitives/data-types/record-ids
- Transitions — JS: https://surrealdb.com/docs/surrealdb/reference/javascript/api/core/surreal-transaction ; multi-statement/HTTP: https://surrealdb.com/docs/surrealdb/reference/mojo/concepts/transactions
- Decimal (money precision): https://surrealdb.com/docs/surrealdb/reference/javascript/api/values/decimal
- DEFINE EVENT (in-transaction, ASYNC): https://surrealdb.com/docs/surrealdb/learn/schema-management/events-and-triggers/defining-events
- Live queries / change feed: https://surrealdb.com/docs/surrealdb/reference/javascript/concepts/live-queries
- Multi-tenancy — multi-DB per tenant: https://surrealdb.com/docs/surrealdb/reference/rust/concepts/multi-tenancy
- `$auth`-scoped PERMISSIONS: https://surrealdb.com/docs/surrealdb/reference/rust/concepts/authenticating-users
- Managed multi-tenancy / scope floors (Spectron): https://surrealdb.com/docs/surrealdb/spectron/self-hosting/security/multi-tenancy