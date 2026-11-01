import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgDb } from "../../src/db/pg";
import { creditPurchase, sendGift, checkInvariants } from "../../src/ledger/ledger";
import { freshDb, TEST_URL } from "./helper";

let owner: PgDb, app: PgDb, fe: PgDb;
const asUser = async (uid: string, sql: string, params: unknown[] = []) => {
  const c = await fe.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const r = await c.query(sql, params as any[]);
    await c.query("COMMIT");
    return r.rows;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
};
const rejects = (p: Promise<unknown>) => expect(p).rejects.toThrow(/permission denied|row-level security|violates/);

beforeAll(async () => {
  owner = await freshDb();
  // SET ROLE after connect needs sequential first query; use dedicated pools with role applied per connection.
  app = new PgDb(TEST_URL, 5, "xtc_app");
  fe = new PgDb(TEST_URL, 5, "xtc_authenticated");
  await creditPurchase(owner, { userId: "alice", coins: 1000n, provider: "simulation", providerTxId: "t1" });
  await creditPurchase(owner, { userId: "bob", coins: 10n, provider: "simulation", providerTxId: "t0" });
});
afterAll(async () => { await owner.close(); await app.close(); await fe.close(); });

describe("least privilege", () => {
  it("runtime role cannot write ledger tables directly", async () => {
    await rejects(app.query("INSERT INTO journal_entries(idempotency_key,type) VALUES ('x','y')"));
    await rejects(app.query("INSERT INTO postings(entry_id,account_id,amount,role) VALUES (1,'wallet:alice',5,'p')"));
    await rejects(app.query("UPDATE ledger_accounts SET balance = 999999 WHERE id='wallet:alice'"));
    await rejects(app.query("DELETE FROM postings"));
    await rejects(app.query("DELETE FROM audit_log"));
  });
  it("runtime role can still move money via the restricted function", async () => {
    await creditPurchase(app, { userId: "bob", coins: 500n, provider: "simulation", providerTxId: "t2" });
    expect((await app.query<{ balance: string }>("SELECT balance FROM ledger_accounts WHERE id='wallet:bob'")).rows[0].balance).toBe("510");
    const inv = await checkInvariants(app);
    expect(inv.globalSum).toBe(0n);
    expect(inv.discrepancies).toEqual([]);
  });
  it("frontend role has no write access to any ledger/payment table", async () => {
    for (const sql of [
      "UPDATE ledger_accounts SET balance=1e12 WHERE id='wallet:bob'",
      "INSERT INTO ledger_accounts(id,kind) VALUES ('wallet:evil','user_wallet')",
      "INSERT INTO postings(entry_id,account_id,amount,role) VALUES (1,'wallet:bob',5,'p')",
      "SELECT ledger_post_entry('k','t','[]'::jsonb,'{}'::jsonb,null,'s')",
      "UPDATE products SET coins=1e9",
      "INSERT INTO webhook_events(provider) VALUES ('x')",
    ]) await rejects(asUser("bob", sql));
  });
  it("RLS: users see only their own accounts and postings", async () => {
    const accts = await asUser("bob", "SELECT id FROM ledger_accounts ORDER BY id");
    expect(accts.map((r) => r.id)).toEqual(["wallet:bob"]);
    const posts = await asUser("bob", "SELECT account_id FROM postings");
    expect(new Set(posts.map((r) => r.account_id))).toEqual(new Set(["wallet:bob"]));
    expect(await asUser("nobody", "SELECT id FROM ledger_accounts")).toEqual([]);
    expect(await asUser("", "SELECT id FROM ledger_accounts")).toEqual([]);
  });
  it("frontend role cannot read audit log or webhook events", async () => {
    await rejects(asUser("bob", "SELECT * FROM audit_log"));
    await rejects(asUser("bob", "SELECT * FROM webhook_events"));
  });
  it("append-only triggers still block superuser-level tampering", async () => {
    await expect(owner.query("UPDATE postings SET amount = 1")).rejects.toThrow();
    await expect(owner.query("DELETE FROM journal_entries")).rejects.toThrow();
  });
});

import { assertLeastPrivilege } from "../../src/db/pg";
import { loadConfig } from "../../src/config";
describe("production guards", () => {
  it("startup assertion rejects superuser and accepts the runtime role", async () => {
    await expect(assertLeastPrivilege(owner)).rejects.toThrow(/over-privileged/);
    await expect(assertLeastPrivilege(app)).resolves.toBeUndefined();
    await expect(assertLeastPrivilege(fe)).resolves.toBeUndefined();
  });
  it("production config refuses simulation payouts, missing Redis, and simulation webhooks", () => {
    const env = { NODE_ENV: "production", DATABASE_URL: "x", WORKER_DATABASE_URL: "x", JWT_SECRET: "s".repeat(40), PAYOUT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "k", REDIS_URL: "redis://x" };
    expect(() => loadConfig(env)).not.toThrow();
    expect(() => loadConfig({ ...env, PAYOUT_PROVIDER: "simulation" })).toThrow(/simulation/);
    expect(() => loadConfig({ ...env, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
    expect(() => loadConfig({ ...env, WEBHOOK_SIMULATION: "true" })).toThrow();
    expect(() => loadConfig({ ...env, STRIPE_SECRET_KEY: undefined })).toThrow(/STRIPE_SECRET_KEY/);
  });
});
