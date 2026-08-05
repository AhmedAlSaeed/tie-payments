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
import { Surreal } from "surrealdb";

export interface DbConfig {
  url: string;
  namespace: string;
  database: string;
  user: string;
  pass: string;
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
  db = await connectDb(envDbConfig());
  return db;
}