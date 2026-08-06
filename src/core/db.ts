/**
 * Shared SurrealDB client(s) for the tie-payments monolith.
 *
 * `connectDb` is the low-level factory — used by the live app path and by
 * tests (which point at an isolated database). `getDb` is a lazy process-wide
 * singleton built from env, so every pillar shares one connection.
 *
 * Config is read from `process.env` (not `Bun.env`) so the module also loads
 * under the Node-based Better Auth CLI when it imports the config. Bun
 * populates process.env from the local `.env`, so runtime behaviour matches.
 */
import { readFileSync } from "node:fs";
import { Surreal } from "surrealdb";

export interface DbConfig {
  url: string;
  namespace: string;
  database: string;
  user: string;
  pass: string;
}

/** Better Auth identity schema (user/session/account/...). */
const AUTH_SCHEMA = readFileSync(new URL("../auth/schema.surql", import.meta.url), "utf8");
/** Platform persistence + tenancy schema (F0 artifact). */
const PLATFORM_SCHEMA = readFileSync(new URL("./schema.surql", import.meta.url), "utf8");

/**
 * Apply the full schema artifact idempotently (both DDL files use IF NOT EXISTS).
 * Call once per process at bootstrap; safe to re-run.
 */
export async function applySchema(db: Surreal): Promise<void> {
  await db.query(AUTH_SCHEMA);
  await db.query(PLATFORM_SCHEMA);
}

export function envDbConfig(): DbConfig {
  return {
    url: process.env.SURREALDB_URL ?? "ws://localhost:8000/rpc",
    namespace: process.env.SURREALDB_NAMESPACE ?? "tie",
    database: process.env.SURREALDB_DATABASE ?? "payments",
    user: process.env.SURREALDB_USER ?? "root",
    pass: process.env.SURREALDB_PASS ?? "root",
  };
}

export async function connectDb(config: DbConfig): Promise<Surreal> {
  const db = new Surreal({ codecOptions: { useNativeDates: true } });
  await db.connect(config.url, {
    namespace: config.namespace,
    database: config.database,
    authentication: { username: config.user, password: config.pass },
  });
  return db;
}

let db: Surreal | undefined;

/** Process-wide singleton. Connect on first use and reuse forever. */
export async function getDb(): Promise<Surreal> {
  if (db) return db;
  const connection = await connectDb(envDbConfig());
  await applySchema(connection);
  db = connection;
  return db;
}
