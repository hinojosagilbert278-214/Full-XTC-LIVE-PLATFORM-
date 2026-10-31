import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import type { Queryable, TxRunner } from "../ledger/ledger";

// Serialization failure / deadlock: safe to retry the whole transaction.
const RETRYABLE = new Set(["40001", "40P01"]);
// bigint columns come back as strings; ledger code converts explicitly.
export const retryable = (e: unknown) => RETRYABLE.has((e as { code?: string })?.code ?? "");

export class PgDb implements Queryable, TxRunner {
  readonly pool: pg.Pool;
  constructor(connectionString: string, max = 20) {
    this.pool = new pg.Pool({ connectionString, max });
    // An idle-client error (e.g. server restart) must not crash the process.
    this.pool.on("error", () => {});
  }

  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
    return this.pool.query(text, values as any[]) as unknown as Promise<{ rows: R[] }>;
  }

  async transaction<T>(fn: (tx: { query: Queryable["query"] }) => Promise<T>, opts: { retries?: number; isolation?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" } = {}): Promise<T> {
    const retries = opts.retries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? "READ COMMITTED"}`);
        const out = await fn({ query: (t: string, v?: unknown[]) => c.query(t, v as any[]) as any });
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        if (retryable(e) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 5 * 2 ** attempt + Math.random() * 10));
          continue;
        }
        throw e;
      } finally {
        c.release();
      }
    }
  }

  close() { return this.pool.end(); }
}

/** Applies every migrations/*.sql in lexical order, serialized by an advisory lock. All migrations are idempotent. */
export async function migrate(db: PgDb, dir = new URL("../../migrations/", import.meta.url)) {
  const files = readdirSync(dir).filter((x) => x.endsWith(".sql")).sort();
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(724001)");
    for (const f of files) await tx.query(readFileSync(new URL(f, dir), "utf8"));
  });
}
