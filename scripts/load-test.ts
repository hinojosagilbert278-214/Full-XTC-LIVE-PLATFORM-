/**
 * Local load / concurrency drill for the Trust Blue ledger and payout engine (real PostgreSQL, SimulatedProvider).
 * Usage: npm run load -- [--seconds 20] [--workers 8] [--creators 20] [--out reports/load-latest.json]
 * Results describe THIS machine and THIS synthetic mix only. No production-capacity claim is made: target workload and
 * acceptance thresholds are not yet defined (see docs/LOAD_TEST_REPORT.md).
 */
import { writeFileSync } from "node:fs";
import { PgDb, migrate } from "../src/db/pg";
import * as L from "../src/ledger/ledger";
import * as P from "../src/payouts/service";
import { SimulatedProvider } from "../src/payouts/provider";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", "20")), WORKERS = Number(arg("workers", "8")), CREATORS = Number(arg("creators", "20"));
const URL_ = process.env.TEST_DATABASE_URL ?? "postgres://xtc:xtc@127.0.0.1:54329/xtc_test";

const lat: Record<string, number[]> = {};
const counts: Record<string, number> = {};
const errs: Record<string, number> = {};
async function timed<T>(op: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t = performance.now();
  try { const r = await fn(); (lat[op] ??= []).push(performance.now() - t); counts[op] = (counts[op] ?? 0) + 1; return r; }
  catch (e) { const k = `${op}:${(e as any).code ?? (e as Error).constructor.name}`; errs[k] = (errs[k] ?? 0) + 1; return undefined; }
}
const pct = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };

async function main() {
  const owner = new PgDb(URL_, 4);
  await owner.query("DROP SCHEMA public CASCADE"); await owner.query("CREATE SCHEMA public"); await migrate(owner);
  const app = new PgDb(URL_, WORKERS * 3, "xtc_app"), admin = new PgDb(URL_, 2, "xtc_admin");
  const sim = new SimulatedProvider();
  for (const [k, v] of Object.entries({ hold_days: "0", coin_value_usd_micros: "10000", min_payout_coins: "10", review_threshold_coins: "1000000", clawback_mode: "debt" })) {
    const id = (await admin.query("SELECT propose_policy($1,$2,'load-a') id", [k, v])).rows[0].id;
    await admin.query("SELECT approve_policy_proposal($1,'load-b')", [id]);
  }
  const creators = Array.from({ length: CREATORS }, (_, i) => `lc${i}`);
  for (const c of creators) await owner.query(`INSERT INTO payout_profiles(user_id,provider_account_id,verification_status,payouts_enabled) VALUES($1,$2,'verified',true)`, [c, `acct_${c}`]);
  await L.creditPurchase(app, { userId: "whale", coins: 1_000_000_000n, provider: "stripe", providerTxId: "whale" });
  // Seed earnings and a paid history so later requests skip first-payout review.
  const seed: number[] = [];
  for (const c of creators) { const g = await L.sendGift(app, { giftId: `seed-${c}`, fromUser: "whale", creatorId: c, coins: 100_000n, familyId: `fam${creators.indexOf(c) % 4}`, familyBps: 1000 }); seed.push(g.entryId);
    const r = await P.requestPayout(app, sim, { userId: c, key: `first-${c}`, coins: 10n, actor: c }); await P.reviewPayout(app, r.payout.id, "approve", "load"); }
  await P.processDuePayouts(app, sim, 100);
  const dl0 = Number((await owner.query("SELECT deadlocks::int d FROM pg_stat_database WHERE datname=current_database()")).rows[0].d);

  const start = Date.now(); const end = start + SECONDS * 1000;
  let waitSamples = 0, maxWaiters = 0;
  const sampler = setInterval(async () => {
    const r = await owner.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()").catch(() => null);
    if (r) { waitSamples += r.rows[0].n; maxWaiters = Math.max(maxWaiters, r.rows[0].n); }
  }, 100);
  const dupKeys: string[] = [];
  const refunded = new Set<number>();
  const worker = async (w: number) => {
    let i = 0;
    while (Date.now() < end) {
      i++; const c = creators[(i * 7 + w) % creators.length]; const roll = (i + w) % 10;
      if (roll < 4) await timed("gift", () => L.sendGift(app, { giftId: `g-${w}-${i}`, fromUser: "whale", creatorId: c, coins: BigInt(100 + (i % 900)), familyId: `fam${creators.indexOf(c) % 4}`, familyBps: 1000 }));
      else if (roll < 6) { // simultaneous requests for the same creator, half with a duplicated key
        const key = i % 2 ? `dup-${c}-${Math.floor(i / 8)}` : `rq-${w}-${i}`; if (i % 2) dupKeys.push(key);
        const r = await timed("payout_request", () => P.requestPayout(app, sim, { userId: c, key, coins: 15n + BigInt(i % 40), actor: c }));
        if (r?.payout.status === "pending_review") await timed("review", () => P.reviewPayout(app, r.payout.id, "approve", "load"));
      } else if (roll < 8) await timed("process", () => P.processDuePayouts(app, sim, 5));
      else if (roll === 8) { // refund of an earlier seed gift while payouts are in flight
        const e = seed[(i + w) % seed.length]; if (!refunded.has(e)) { refunded.add(e); await timed("refund_clawback", () => P.reverseWithClawback(app, { entryId: e, key: `rf-${e}`, reason: "load refund" })); }
      } else { // chargeback hold placement for a purchase whose coins were spent
        const pe = Number((await owner.query("SELECT id FROM journal_entries WHERE idempotency_key='purchase:stripe:whale'")).rows[0].id);
        await timed("chargeback_holds", async () => (await app.query("SELECT place_chargeback_holds($1, 1)", [pe])).rows[0]);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
  clearInterval(sampler);
  const elapsed = (Date.now() - start) / 1000;

  // Drain: expire leases and finish in-flight work, then reconcile.
  for (let k = 0; k < 6; k++) { await owner.query("UPDATE payouts SET lease_until = now() - interval '1 second' WHERE status='processing'"); await P.processDuePayouts(app, sim, 200); }
  const rt = performance.now(); const rec = await P.reconcilePayouts(app, sim); const reconMs = performance.now() - rt;
  const inv = await L.checkInvariants(owner);
  const dupTransfers = (await owner.query("SELECT count(*)::int n FROM (SELECT payout_id FROM payout_provider_evidence GROUP BY 1 HAVING count(*)>1) x")).rows[0].n;
  const paid = (await owner.query("SELECT count(*)::int n FROM payouts WHERE status='paid'")).rows[0].n;
  const byStatus = Object.fromEntries((await owner.query("SELECT status, count(*)::int n FROM payouts GROUP BY 1")).rows.map((r: any) => [r.status, r.n]));
  const dupIdem = (await owner.query("SELECT count(*)::int n FROM (SELECT idempotency_key FROM payouts GROUP BY 1 HAVING count(*)>1) x")).rows[0].n;
  const unbalanced = (await owner.query("SELECT count(*)::int n FROM (SELECT entry_id FROM postings GROUP BY 1 HAVING sum(amount)<>0) x")).rows[0].n;
  const negative = (await owner.query("SELECT count(*)::int n FROM ledger_accounts WHERE balance<0 AND NOT allow_negative")).rows[0].n;
  const dl1 = Number((await owner.query("SELECT deadlocks::int d FROM pg_stat_database WHERE datname=current_database()")).rows[0].d);
  const totalOps = Object.values(counts).reduce((a, b) => a + b, 0);
  const report = {
    config: { seconds: SECONDS, workers: WORKERS, creators: CREATORS, node: process.version, note: "synthetic mix on one local machine; NOT a capacity claim" },
    throughput: { elapsedSeconds: +elapsed.toFixed(1), successfulOps: totalOps, opsPerSecond: +(totalOps / elapsed).toFixed(1), perOp: counts },
    latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: pct(v, .5), p95: pct(v, .95), p99: pct(v, .99), max: +Math.max(...v).toFixed(2) }])),
    contention: { pgDeadlocksDuringRun: dl1 - dl0, appDeadlockRetries: app.stats.deadlocks, serializationRetries: app.stats.serializationFailures, totalTxRetries: app.stats.retries,
      retryRatePerTx: +(app.stats.retries / Math.max(1, app.stats.transactions)).toFixed(5), lockWaitSamples: waitSamples, maxConcurrentLockWaiters: maxWaiters, transactionsRolledBack_includingBusinessRejections: app.stats.failures },
    expectedRejections: errs,
    providerSimulation: { createCalls: sim.calls, transfers: sim.transfers.size },
    endState: { payoutsByStatus: byStatus, paid, globalLedgerSum: inv.globalSum.toString(), unbalancedEntries: unbalanced, ledgerDiscrepancies: inv.discrepancies.length, unexpectedNegativeBalances: negative,
      duplicatePayoutIdempotencyKeys: dupIdem, payoutsWithMultipleEvidence: dupTransfers, transfersEqualPaidPayouts: sim.transfers.size === paid, callsEqualTransfers: sim.calls === sim.transfers.size,
      reconciliationOk: rec.ok, reconciliationMismatches: rec.mismatches.length, reconciliationMs: +reconMs.toFixed(1) },
  };
  const pass = report.endState.globalLedgerSum === "0" && !unbalanced && !inv.discrepancies.length && !negative && !dupIdem && !dupTransfers && rec.ok && report.endState.transfersEqualPaidPayouts && report.endState.callsEqualTransfers;
  const out = { ...report, invariantsPassed: pass };
  writeFileSync(arg("out", "reports/load-latest.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await app.close(); await admin.close(); await owner.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
