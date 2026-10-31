import { PgDb, migrate } from "../../src/db/pg";

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://xtc:xtc@127.0.0.1:54329/xtc_test";

/** Fresh schema on a real PostgreSQL server. Test files run serially (see vitest.config.ts). */
export async function freshDb(): Promise<PgDb> {
  const db = new PgDb(TEST_URL);
  await db.query("DROP SCHEMA public CASCADE");
  await db.query("CREATE SCHEMA public");
  await migrate(db);
  return db;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function deferred<T = void>() {
  let resolve!: (v?: T) => void;
  const promise = new Promise<T>((r) => (resolve = r as any));
  return { promise, resolve };
}
