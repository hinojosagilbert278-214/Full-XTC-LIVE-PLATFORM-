import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgDb } from "../../src/db/pg";
import * as L from "../../src/ledger/ledger";
import * as P from "../../src/payouts/service";
import { SimulatedProvider } from "../../src/payouts/provider";
import { approvePolicies, freshDb, loginDb, TEST_URL } from "../pg/helper";

/**
 * Backup/restore drill against real PostgreSQL: pg_dump (custom format, single snapshot) -> pg_restore into a clean database.
 * Scope: logical backup on one local cluster. Not covered: PITR/WAL archiving, off-box storage, cross-cluster role restore.
 */
const PGBIN = "/usr/lib/postgresql/16/bin";
const RESTORE_DB = "xtc_restore";
const url = (db: string) => TEST_URL.replace(/\/[^/]+$/, `/${db}`);
const TABLES = ["ledger_accounts", "journal_entries", "postings", "payouts", "payout_events", "payout_holds", "payout_hold_events", "payout_provider_evidence",
  "payout_profiles", "accounting_policy", "accounting_policy_history", "policy_proposals", "audit_log", "refund_requests", "webhook_events", "ddl_audit"];

let src: PgDb, app: PgDb, admin: PgDb, dst: PgDb, sim: SimulatedProvider, dir: string;
const digests = async (db: PgDb) => {
  const out: Record<string, string> = {};
  for (const t of TABLES) out[t] = (await db.query(`SELECT count(*)::text || ':' || COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') d FROM ${t} x`)).rows[0].d;
  return out;
};
const dump = (from: string, file: string) => execFileSync(`${PGBIN}/pg_dump`, ["-Fc", "--no-owner", "-f", file, url(from)]);
const restore = async (file: string) => {
  await src.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await src.query(`CREATE DATABASE ${RESTORE_DB}`);
  // Event trigger guard is dumped with the schema; restore is a sanctioned schema operation.
  execFileSync(`${PGBIN}/pg_restore`, ["--no-owner", "--exit-on-error", "-d", url(RESTORE_DB), file], { env: { ...process.env, PGOPTIONS: "-c xtc.migrating=on" } });
  dst = new PgDb(url(RESTORE_DB));
};
const expireLeases = (db: PgDb) => db.query("UPDATE payouts SET lease_until = now() - interval '1 second' WHERE status='processing'");

beforeAll(async () => {
  src = await freshDb(); app = loginDb("t_worker", 10); admin = loginDb("t_admin", 3); sim = new SimulatedProvider();
  dir = mkdtempSync(join(tmpdir(), "xtc-dr-"));
  await approvePolicies({ hold_days: "0", coin_value_usd_micros: "10000", min_payout_coins: "10", review_threshold_coins: "100000", clawback_mode: "debt" });
  for (const u of ["c1", "c2", "c3"]) await src.query(`INSERT INTO payout_profiles(user_id,provider_account_id,verification_status,payouts_enabled) VALUES($1,$2,'verified',true)`, [u, `acct_${u}`]);
  for (const [i, c] of ["c1", "c2", "c3"].entries()) {
    await L.creditPurchase(app, { userId: `fan${i}`, coins: 5000n, provider: "stripe", providerTxId: `tx${i}` });
    await L.sendGift(app, { giftId: `g${i}`, fromUser: `fan${i}`, creatorId: c, coins: 5000n, familyId: "f1", familyBps: 1000 });
  }
  await app.query("INSERT INTO audit_log(actor, action, resource, outcome) VALUES('sys','drill.seed','x','ok')").catch(() => {});
});
afterAll(async () => {
  await dst?.close(); await src.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`).catch(() => {});
  await src.close(); await app.close(); await admin.close(); rmSync(dir, { recursive: true, force: true });
});

describe("backup / restore drill", () => {
  it("quiesced dump restores to an identical financial state, with constraints and triggers intact", async () => {
    // c1: paid, c2: interrupted mid-payout (provider succeeded, response lost), c3: queued and untouched, plus a hold.
    const mk = async (u: string, coins: bigint, key: string) => { const r = await P.requestPayout(app, sim, { userId: u, key, coins, actor: u }); if (r.payout.status === "pending_review") await P.reviewPayout(app, r.payout.id, "approve", "admin1"); return r.payout.id; };
    await mk("c1", 500n, "p1"); await P.processDuePayouts(app, sim);
    const id2 = await mk("c2", 500n, "p2"); sim.failNext("unknown_after"); await P.processDuePayouts(app, sim);
    await mk("c3", 500n, "p3");
    await src.query("INSERT INTO payout_holds(user_id,kind,amount,reason,created_by) VALUES('c3','admin',100,'drill','admin1')");
    await expireLeases(src);
    const before = await digests(src);
    const file = join(dir, "q.dump"); const t0 = Date.now(); dump("xtc_test", file); const dumpMs = Date.now() - t0;
    const t1 = Date.now(); await restore(file); const restoreMs = Date.now() - t1;
    console.log(`[drill] dump ${dumpMs}ms (${statSync(file).size} bytes), restore ${restoreMs}ms`);

    expect(await digests(dst)).toEqual(before);
    const inv = await L.checkInvariants(dst); expect(inv.globalSum).toBe(0n); expect(inv.discrepancies).toEqual([]);
    expect((await dst.query("SELECT status, count(*)::int n FROM payouts GROUP BY 1 ORDER BY 1")).rows).toEqual([{ status: "paid", n: 1 }, { status: "processing", n: 1 }, { status: "queued", n: 1 }]);
    expect((await dst.query("SELECT key, value, version FROM accounting_policy WHERE value IS NOT NULL ORDER BY key")).rows.length).toBe(5);
    expect((await dst.query("SELECT count(*)::int n FROM accounting_policy_history WHERE proposed_by='policy_alice' AND actor='policy_bob'")).rows[0].n).toBe(5);

    // Guards survived the restore.
    await expect(dst.query("UPDATE journal_entries SET created_at=now()")).rejects.toThrow(/append-only/);
    const dba = loginDb("dba_np", 2, url(RESTORE_DB)), plain = loginDb("t_app", 2, url(RESTORE_DB));
    await expect(dba.query("TRUNCATE postings CASCADE")).rejects.toThrow(/blocked|permission denied|must be owner/);
    await expect(plain.query("TRUNCATE postings CASCADE")).rejects.toThrow(/permission denied/);
    await dba.close(); await plain.close();
    await expect(dst.query("UPDATE payouts SET status='paid' WHERE id=$1", [id2])).rejects.toThrow(/provider evidence/);
    const dstApp = loginDb("t_worker", 5, url(RESTORE_DB));
    await expect(loginDb("t_app", 1, url(RESTORE_DB)).query("UPDATE ledger_accounts SET balance=999999")).rejects.toThrow(/permission denied/);

    // Idempotency records survived: replays are no-ops.
    expect((await L.creditPurchase(dstApp, { userId: "fan0", coins: 5000n, provider: "stripe", providerTxId: "tx0" })).replayed).toBe(true);
    expect((await P.requestPayout(dstApp, sim, { userId: "c1", key: "p1", coins: 500n, actor: "c1" })).replayed).toBe(true);

    // Interrupted payout recovery on the restored DB: provider already holds the transfer.
    const calls = sim.calls;
    const out = await P.processDuePayouts(dstApp, sim, 10);
    expect(out.paid).toBe(2); // c2 adopted via lookup; c3 created
    expect(sim.transfers.size).toBe(3); // one per payout, no duplicates
    expect(sim.calls - calls).toBe(1); // only c3 needed a create
    const again = await P.processDuePayouts(dstApp, sim, 10); expect(again).toMatchObject({ paid: 0 });
    const rec = await P.reconcilePayouts(dstApp, sim); expect(rec.ok).toBe(true);
    await dstApp.close();
  });

  it("restoring a backup OLDER than the provider's state cannot create a second transfer", async () => {
    // Fresh payout queued at backup time; the provider pays it afterwards; the DB is then restored to the backup.
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "late", coins: 200n, actor: "c1" });
    if (r.payout.status === "pending_review") await P.reviewPayout(app, r.payout.id, "approve", "admin1");
    const file = join(dir, "old.dump"); dump("xtc_test", file);
    await P.processDuePayouts(app, sim); // provider now has the transfer; source DB moves on
    const transfersAtProvider = sim.transfers.size, calls = sim.calls;
    await dst.close(); await restore(file);
    expect((await dst.query("SELECT status FROM payouts WHERE id=$1", [r.payout.id])).rows[0].status).toBe("queued"); // restored DB is behind the provider
    const dstApp = loginDb("t_worker", 5, url(RESTORE_DB));
    const out = await P.processDuePayouts(dstApp, sim, 10);
    expect(out.paid).toBeGreaterThanOrEqual(1);
    expect(sim.transfers.size).toBe(transfersAtProvider); expect(sim.calls).toBe(calls); // adopted, never re-created
    expect((await P.reconcilePayouts(dstApp, sim)).ok).toBe(true);
    await dstApp.close();
  });

  it("a dump taken while load is running (gifts, payouts, workers) is a consistent snapshot", async () => {
    await L.creditPurchase(app, { userId: "bulk", coins: 1_000_000n, provider: "stripe", providerTxId: "bulk" });
    for (const u of ["c1", "c2", "c3"]) await L.sendGift(app, { giftId: `seed-${u}`, fromUser: "bulk", creatorId: u, coins: 100_000n });
    let stop = false; let ops = 0;
    const worker = async (n: number) => {
      let i = 0;
      while (!stop) {
        i++; const u = `c${(i % 3) + 1}`;
        try {
          await L.sendGift(app, { giftId: `ld-${n}-${i}`, fromUser: "bulk", creatorId: u, coins: 100n + BigInt(i % 50) });
          if (i % 3 === 0) { const r = await P.requestPayout(app, sim, { userId: u, key: `ldp-${n}-${i}`, coins: 20n, actor: u }); if (r.payout.status === "pending_review") await P.reviewPayout(app, r.payout.id, "approve", "admin1"); }
          if (i % 4 === 0) await P.processDuePayouts(app, sim, 5);
          ops++;
        } catch { /* contention/ineligible requests are acceptable during the drill */ }
      }
    };
    const ws = [worker(1), worker(2), worker(3), worker(4)];
    await new Promise((r) => setTimeout(r, 1500));
    const file = join(dir, "live.dump"); dump("xtc_test", file);
    stop = true; await Promise.all(ws);
    await dst.close(); await restore(file);
    const inv = await L.checkInvariants(dst);
    expect(inv.globalSum).toBe(0n); expect(inv.discrepancies).toEqual([]);
    const dstApp = loginDb("t_worker", 5, url(RESTORE_DB));
    // Providers outside the snapshot may be ahead of it: recovery must adopt, never duplicate.
    const calls = sim.calls, transfers = sim.transfers.size;
    for (let i = 0; i < 5; i++) { await expireLeases(dst); await P.processDuePayouts(dstApp, sim, 50); }
    expect(sim.transfers.size - transfers).toBeLessThanOrEqual(sim.calls - calls); // a transfer only appears with a create call
    const payoutsDone = (await dst.query("SELECT count(*)::int n FROM payouts WHERE status='paid'")).rows[0].n;
    const ids = (await dst.query("SELECT id FROM payouts")).rows.map((r: any) => Number(r.id));
    for (const id of ids) expect([...sim.transfers.values()].filter((t) => t.payoutId === id).length).toBeLessThanOrEqual(1);
    expect((await P.reconcilePayouts(dstApp, sim)).ok).toBe(true);
    console.log(`[drill] dump under load: ${ops} ops completed during run, ${payoutsDone} paid payouts in snapshot-after-recovery`);
    await dstApp.close();
  });
});
