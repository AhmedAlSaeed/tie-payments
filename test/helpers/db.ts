/**
 * Test SurrealDB — isolated database + schema bootstrap.
 *
 * Integration tests create their own `payments_test` database (schema DDL is
 * idempotent), so dev data is never touched. `isSurrealAvailable` lets suites
 * `skipIf` when the dockerized server isn't running.
 */
import { readFileSync } from "node:fs";
import { Surreal } from "surrealdb";
import { envDbConfig } from "../../src/core/db";

export const TEST_NAMESPACE = envDbConfig().namespace;

export function testDatabaseName(): string {
  return process.env.SURREAL_TEST_DATABASE ?? "payments_test";
}

const AUTH_SCHEMA = readFileSync(
  new URL("../../src/auth/schema.surql", import.meta.url),
  "utf8",
);

export interface TestDb {
  db: Surreal;
  database: string;
  close(): Promise<void | boolean>;
}

export async function isSurrealAvailable(): Promise<boolean> {
  const cfg = envDbConfig();
  try {
    const db = new Surreal({ codecOptions: { useNativeDates: true } });
    await db.connect(cfg.url, {
      authentication: { username: cfg.user, password: cfg.pass },
    });
    await db.close();
    return true;
  } catch {
    return false;
  }
}

export async function createTestDb(): Promise<TestDb> {
  const cfg = envDbConfig();
  const db = new Surreal({ codecOptions: { useNativeDates: true } });
  await db.connect(cfg.url, {
    authentication: { username: cfg.user, password: cfg.pass },
  });

  const database = testDatabaseName();
  await db.query("DEFINE NAMESPACE IF NOT EXISTS $ns;", { ns: cfg.namespace });
  await db.use({ namespace: cfg.namespace });
  await db.query("DEFINE DATABASE IF NOT EXISTS $db;", { db: database });
  await db.use({ namespace: cfg.namespace, database });
  await db.query(AUTH_SCHEMA);

  return { db, database, close: () => db.close() };
}
