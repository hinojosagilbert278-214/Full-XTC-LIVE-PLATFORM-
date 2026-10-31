import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import type { Queryable, TxRunner } from "../ledger/ledger";

// Serialization failure / deadlock: safe to retry the whole transaction.
const RETRYABLE = new Set(["40001", "40P01"]);
// bigint columns come back as strings; ledger code converts explicitly.
export const retryable = (e: unknown) => RETRYABLE.has((e as { code?: string })?.code ?? "");

export class PgDb implements Queryable, TxRunner {
  readonly pool: pg.Pool;
  constructor(connectionString: string, max = 20, role?: string) {
    this.pool = new pg.Pool({ connectionString, max });
    // Role names are internal constants, never user input.
    if (role) {
      if (!/^[a-z_]+$/.test(role)) throw new Error("invalid role");
      this.pool.on("connect", (c) => { c.query(`SET ROLE ${role}`).catch(() => {}); });
    }
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
    await tx.query("SELECT set_config('xtc.migrating','on',true)"); // permits schema changes past the DDL guard for this transaction only
    for (const f of files) await tx.query(readFileSync(new URL(f, dir), "utf8"));
    const t = await tx.query("SELECT to_regclass('public.ddl_audit') AS t");
    if (t.rows[0].t) await tx.query("INSERT INTO ddl_audit(actor, note) VALUES (session_user, $1)", [`migrate ${files.join(",")}`]);
  });
}

/** Production guard: the runtime must not hold superuser/BYPASSRLS or direct write access to the ledger. */
export async function assertLeastPrivilege(db: { query: PgDb["query"] }) {
  const r = await db.query<{ su: boolean; bypass: boolean; ins_postings: boolean; ins_entries: boolean; upd_balance: boolean; del_audit: boolean }>(
    `SELECT r.rolsuper su, r.rolbypassrls bypass,
            has_table_privilege(current_user,'postings','INSERT') ins_postings,
            has_table_privilege(current_user,'journal_entries','INSERT') ins_entries,
            has_column_privilege(current_user,'ledger_accounts','balance','UPDATE') upd_balance,
            has_table_privilege(current_user,'audit_log','DELETE') del_audit
       FROM pg_roles r WHERE r.rolname = current_user`);
  const x = r.rows[0];
  const bad = Object.entries(x).filter(([, v]) => v).map(([k]) => k);
  if (bad.length) throw new Error(`database role is over-privileged: ${bad.join(", ")}`);
}
