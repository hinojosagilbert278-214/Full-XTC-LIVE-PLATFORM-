import pg from "pg";
import { PgDb, migrate } from "../../src/db/pg";

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://xtc:xtc@127.0.0.1:54329/xtc_test";

/** Fresh schema on a real PostgreSQL server. Test files run serially (see vitest.config.ts). */
export async function freshDb(): Promise<PgDb> {
  const db = new PgDb(TEST_URL);
  await db.query("DROP SCHEMA public CASCADE");
  await db.query("CREATE SCHEMA public");
  await migrate(db);
  await ensureLogins(db);
  return db;
}

/** Same server, different authenticated login (the test cluster uses trust auth; production uses real credentials). */
export function loginUrl(user: string, base = TEST_URL) { const u = new URL(base); u.username = user; u.password = ""; return u.toString(); }
export const loginDb = (user: string, max = 5, base = TEST_URL) => new PgDb(loginUrl(user, base), max);

const LOGINS: Array<[string, string, string]> = [
  ["t_app", "xtc_app", ""], ["t_worker", "xtc_provider_worker", ""], ["t_admin", "xtc_admin", ""],
  ["policy_alice", "xtc_policy_admin", ""], ["policy_bob", "xtc_policy_admin", ""], ["policy_carol", "xtc_policy_admin", ""],
  // A privileged but NOT superuser login: can create roles and databases, and is made table owner in owner-bypass tests.
  ["dba_np", "xtc_admin", "CREATEROLE CREATEDB"],
];
/** Test-harness provisioning of real, separate, non-superuser logins (cluster-level; idempotent). Run as the migrator. */
export async function ensureLogins(db: { query: PgDb["query"] }) {
  for (const [u, g, attrs] of LOGINS) {
    await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${u}') THEN CREATE ROLE ${u} LOGIN ${attrs}; END IF; END $$`);
    await db.query(`GRANT ${g} TO ${u}`);
  }
}

/** Runs fn as a specific login over a dedicated connection (no SET ROLE: session_user IS that login). */
export async function asLogin<T>(user: string, fn: (c: pg.Client) => Promise<T>, base = TEST_URL): Promise<T> {
  const c = new pg.Client({ connectionString: loginUrl(user, base) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Two distinct administrators approve each policy value: alice proposes, bob approves. */
export async function approvePolicies(values: Record<string, string>, base = TEST_URL) {
  for (const [k, v] of Object.entries(values)) {
    const id = (await asLogin("policy_alice", (c) => c.query("SELECT propose_policy($1,$2) id", [k, v]), base)).rows[0].id;
    await asLogin("policy_bob", (c) => c.query("SELECT approve_policy_proposal($1)", [id]), base);
  }
}

/** Test isolation only: resets approvals. Requires superuser (replica mode skips the guard triggers). Not a production path. */
export async function resetPolicies(owner: { query: PgDb["query"] }, keys?: string[]) {
  await owner.query(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE accounting_policy SET value=NULL, approved_by=NULL, approved_at=NULL, proposed_by=NULL, proposal_id=NULL, version=0
     ${keys ? `WHERE key = ANY(ARRAY[${keys.map((k) => `'${k}'`).join(",")}])` : ""};
    DELETE FROM accounting_policy_history ${keys ? `WHERE key = ANY(ARRAY[${keys.map((k) => `'${k}'`).join(",")}])` : ""}; COMMIT`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function deferred<T = void>() {
  let resolve!: (v?: T) => void;
  const promise = new Promise<T>((r) => (resolve = r as any));
  return { promise, resolve };
}
