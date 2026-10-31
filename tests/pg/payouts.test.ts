import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgDb } from "../../src/db/pg";
import * as L from "../../src/ledger/ledger";
import * as P from "../../src/payouts/service";
import { SimulatedProvider } from "../../src/payouts/provider";
import { freshDb, TEST_URL } from "./helper";

let owner: PgDb, app: PgDb, sim: SimulatedProvider;
const POLICY: Record<string, string> = { hold_days: "0", coin_value_usd_micros: "10000", min_payout_coins: "10", review_threshold_coins: "1000", clawback_mode: "debt" };

async function approvePolicy(over: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...POLICY, ...over })) {
    const id = (await owner.query("SELECT propose_policy($1,$2,'finance-a') id", [k, v])).rows[0].id;
    await owner.query("SELECT approve_policy_proposal($1,'finance-b')", [id]);
  }
}
beforeAll(async () => { owner = await freshDb(); app = new PgDb(TEST_URL, 20, "xtc_app"); });
afterAll(async () => { await owner.close(); await app.close(); });
beforeEach(async () => {
  await owner.query(`BEGIN; SELECT set_config('xtc.allow_destructive','on',true); TRUNCATE postings, journal_entries, ledger_accounts, audit_log, payouts, payout_events, payout_holds, payout_profiles, refund_requests RESTART IDENTITY CASCADE; COMMIT`);
  await owner.query("BEGIN; SELECT set_config('xtc.policy_fn','on',true); UPDATE accounting_policy SET value=NULL, approved_by=NULL, approved_at=NULL, version=0; COMMIT");
  sim = new SimulatedProvider();
});

/** Creator ends up with floor(0.7*gross) coins of earnings. */
async function earn(creator: string, gross: bigint, tag = String(Math.random())) {
  await L.creditPurchase(app, { userId: `fan-${tag}`, coins: gross, provider: "simulation", providerTxId: `p-${tag}` });
  return L.sendGift(app, { giftId: `g-${tag}`, fromUser: `fan-${tag}`, creatorId: creator, coins: gross });
}
const verify = (u: string) => owner.query(`INSERT INTO payout_profiles(user_id,provider_account_id,verification_status,payouts_enabled) VALUES($1,$2,'verified',true) ON CONFLICT (user_id) DO UPDATE SET verification_status='verified', payouts_enabled=true`, [u, `acct_${u}`]);
const bal = (id: string) => L.balanceOf(owner, id);
const status = async (id: string | number) => (await owner.query<{ status: string }>("SELECT status FROM payouts WHERE id=$1", [id])).rows[0].status;
async function ready(u: string, coins: bigint) { // payout queued (past first-payout review)
  const r = await P.requestPayout(app, sim, { userId: u, key: `k-${Math.random()}`, coins, actor: u });
  if (r.payout.status === "pending_review") await P.reviewPayout(app, r.payout.id, "approve", "admin1");
  return r.payout.id;
}
async function expireLeases() { await owner.query("UPDATE payouts SET lease_until = now() - interval '1 second' WHERE status='processing'"); }
async function inv() { const i = await L.checkInvariants(owner); expect(i.globalSum).toBe(0n); expect(i.discrepancies).toEqual([]); }

describe("policy gate", () => {
  it("refuses payouts while any required policy is unapproved (app and database)", async () => {
    await earn("c1", 1000n); await verify("c1");
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "k", coins: 100n, actor: "c1" })).rejects.toThrow(P.PolicyNotApprovedError);
    await expect(owner.query(`INSERT INTO payouts(user_id,idempotency_key,amount_coins,amount_minor,currency,rate_micros,status,provider,provider_account_id) VALUES('c1','x',1,1,'usd',1,'queued','p','a')`)).rejects.toThrow(/policy_not_approved/);
  });
  it("approval is recorded with actor in append-only history; app role cannot approve", async () => {
    await approvePolicy();
    const h = await owner.query("SELECT count(*)::int n FROM accounting_policy_history");
    expect(h.rows[0].n).toBe(5);
    await expect(app.query("SELECT approve_policy_proposal(1,'me')")).rejects.toThrow(/permission denied/);
    await expect(owner.query("UPDATE accounting_policy_history SET actor='x'")).rejects.toThrow(/append-only/);
    await expect(app.query("UPDATE accounting_policy SET value='1'")).rejects.toThrow(/permission denied/);
  });
});

describe("availability", () => {
  it("splits pending / held / debt / available from immutable postings", async () => {
    await approvePolicy({ hold_days: "7" });
    await earn("c1", 1000n); // creator share 700, all younger than 7 days
    let a = await P.availability(app, "c1");
    expect([a.balance, a.pending, a.available]).toEqual([700n, 700n, 0n]);
    await owner.query("UPDATE journal_entries SET created_at = now() - interval '8 days'").catch(() => {}); // blocked: append-only
    // age the earnings legitimately for the test by superuser trigger bypass
    await owner.query("BEGIN; SELECT set_config('xtc.migrating','on',true); ALTER TABLE journal_entries DISABLE TRIGGER USER; UPDATE journal_entries SET created_at = now() - interval '8 days'; ALTER TABLE journal_entries ENABLE TRIGGER USER; COMMIT");
    a = await P.availability(app, "c1");
    expect([a.pending, a.available]).toEqual([0n, 700n]);
    await owner.query("INSERT INTO payout_holds(user_id,kind,amount,reason) VALUES('c1','admin',200,'review')");
    a = await P.availability(app, "c1");
    expect([a.held, a.available]).toEqual([200n, 500n]);
  });
});

describe("payout request", () => {
  beforeEach(async () => { await approvePolicy(); await earn("c1", 1000n); await verify("c1"); }); // c1 has 700
  it("reserves funds in the ledger and starts in pending_review for a first payout", async () => {
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "a", coins: 300n, actor: "c1" });
    expect(r.payout.status).toBe("pending_review");
    expect(await bal("earnings:c1")).toBe(400n); expect(await bal(P.CLEARING)).toBe(300n);
    expect(r.payout.amount_minor).toBe("300");
    await inv();
  });
  it("rejects unverified accounts, below-minimum and over-available requests", async () => {
    await owner.query("UPDATE payout_profiles SET verification_status='pending'");
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "a", coins: 100n, actor: "c1" })).rejects.toMatchObject({ code: "account_not_verified" });
    await verify("c1");
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "b", coins: 5n, actor: "c1" })).rejects.toMatchObject({ code: "below_minimum" });
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "c", coins: 701n, actor: "c1" })).rejects.toMatchObject({ code: "insufficient_available" });
    await expect(P.requestPayout(app, sim, { userId: "nobody", key: "d", coins: 100n, actor: "x" })).rejects.toMatchObject({ code: "no_payout_account" });
    expect(await bal("earnings:c1")).toBe(700n);
  });
  it("is idempotent: same key replays, different amount conflicts, 20 concurrent duplicates make one payout", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => P.requestPayout(app, sim, { userId: "c1", key: "same", coins: 100n, actor: "c1" })));
    expect(new Set(rs.map((r) => r.payout.id)).size).toBe(1);
    expect(rs.filter((r) => !r.replayed).length).toBe(1);
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "same", coins: 101n, actor: "c1" })).rejects.toThrow(L.IdempotencyConflictError);
    expect(await bal(P.CLEARING)).toBe(100n);
    await inv();
  });
  it("concurrent distinct requests cannot reserve more than available", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => P.requestPayout(app, sim, { userId: "c1", key: `k${i}`, coins: 200n, actor: "c1" })));
    expect(rs.filter((r) => r.status === "fulfilled").length).toBe(3); // 3*200 <= 700 < 4*200
    expect(await bal("earnings:c1")).toBe(100n);
    expect(await bal(P.CLEARING)).toBe(600n);
    await inv();
  });
  it("a spend-side race: earnings reserved by a payout cannot also be reserved twice", async () => {
    const [a, b] = await Promise.allSettled([
      P.requestPayout(app, sim, { userId: "c1", key: "x1", coins: 700n, actor: "c1" }),
      P.requestPayout(app, sim, { userId: "c1", key: "x2", coins: 700n, actor: "c1" })]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  });
  it("rolls back the payout row when the ledger reservation fails", async () => {
    await owner.query("UPDATE ledger_accounts SET frozen=true WHERE id='earnings:c1'");
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "f", coins: 100n, actor: "c1" })).rejects.toThrow();
    expect((await owner.query("SELECT count(*)::int n FROM payouts")).rows[0].n).toBe(0);
    expect(await bal("earnings:c1")).toBe(700n);
  });
});

describe("state machine", () => {
  beforeEach(async () => { await approvePolicy(); await earn("c1", 1000n); await verify("c1"); });
  it("happy path: review -> queued -> processing -> paid, with settled ledger and full history", async () => {
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "a", coins: 300n, actor: "c1" });
    expect((await P.processDuePayouts(app, sim)).paid).toBe(0); // not approved: nothing runs
    await P.reviewPayout(app, r.payout.id, "approve", "admin1");
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ paid: 1 });
    expect(await status(r.payout.id)).toBe("paid");
    expect(await bal(P.CLEARING)).toBe(0n); expect(await bal(P.PAID)).toBe(300n);
    const ev = await owner.query("SELECT from_status, to_status FROM payout_events WHERE payout_id=$1 ORDER BY id", [r.payout.id]);
    expect(ev.rows.map((e) => e.to_status)).toEqual(["pending_review", "queued", "processing", "paid"]);
    expect(sim.calls).toBe(1);
    const rec = await P.reconcilePayouts(app, sim); expect(rec.ok).toBe(true);
    await inv();
  });
  it("database rejects illegal transitions and edits of financial fields even for the owner", async () => {
    const id = await ready("c1", 100n);
    await expect(owner.query("UPDATE payouts SET status='paid' WHERE id=$1", [id])).rejects.toThrow(/illegal payout transition/);
    await expect(owner.query("UPDATE payouts SET amount_coins=999 WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await P.processDuePayouts(app, sim);
    await expect(owner.query("UPDATE payouts SET status='queued' WHERE id=$1", [id])).rejects.toThrow(/illegal payout transition/);
    await expect(owner.query("UPDATE payouts SET provider_ref='other' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(owner.query("DELETE FROM payout_events")).rejects.toThrow(/append-only/);
    await expect(app.query("DELETE FROM payouts")).rejects.toThrow(/permission denied/);
  });
  it("review rejection and user cancellation return funds exactly once", async () => {
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "a", coins: 300n, actor: "c1" });
    await P.reviewPayout(app, r.payout.id, "reject", "admin1");
    expect(await bal("earnings:c1")).toBe(700n);
    await expect(P.cancelPayout(app, r.payout.id, "c1")).rejects.toMatchObject({ code: "not_cancellable" });
    await expect(P.reviewPayout(app, r.payout.id, "reject", "admin1")).rejects.toMatchObject({ code: "not_pending_review" });
    const id2 = await ready("c1", 200n);
    await expect(P.cancelPayout(app, id2, "someone-else", { userId: "someone-else" })).rejects.toMatchObject({ code: "not_found" });
    await P.cancelPayout(app, id2, "c1", { userId: "c1" });
    expect(await bal("earnings:c1")).toBe(700n); expect(await bal(P.CLEARING)).toBe(0n);
    await inv();
  });
  it("provider rejection fails the payout and returns the reserve", async () => {
    const id = await ready("c1", 300n);
    sim.failNext("reject");
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ failed: 1 });
    expect(await status(id)).toBe("failed");
    expect(await bal("earnings:c1")).toBe(700n); expect(await bal(P.CLEARING)).toBe(0n);
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ paid: 0, failed: 0 });
    await inv();
  });
  it("reversal after payment restores earnings through a new entry and cannot repeat", async () => {
    const id = await ready("c1", 300n); await P.processDuePayouts(app, sim);
    await P.reversePayout(app, id, "transfer reversed", "admin1");
    expect(await bal(P.PAID)).toBe(0n); expect(await bal("earnings:c1")).toBe(700n);
    await expect(P.reversePayout(app, id, "again", "admin1")).rejects.toMatchObject({ code: "not_reversible" });
    expect((await owner.query("SELECT count(*)::int n FROM journal_entries WHERE type='payout_reverse'")).rows[0].n).toBe(1);
    await inv();
  });
});

describe("failure recovery", () => {
  beforeEach(async () => { await approvePolicy(); await earn("c1", 10000n); await verify("c1"); });
  it("timeout AFTER the provider created the transfer: recovered by lookup, exactly one transfer", async () => {
    const id = await ready("c1", 300n);
    sim.failNext("unknown_after");
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ retried: 1 });
    expect(await status(id)).toBe("processing");
    expect(await bal(P.CLEARING)).toBe(300n); // still reserved, never returned on uncertainty
    await expireLeases();
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ paid: 1 });
    expect(sim.transfers.size).toBe(1); expect(sim.calls).toBe(1);
    expect(await bal(P.PAID)).toBe(300n); await inv();
  });
  it("timeout BEFORE reaching the provider: retried with the same idempotency key, one transfer", async () => {
    const id = await ready("c1", 300n);
    sim.failNext("unknown_before");
    await P.processDuePayouts(app, sim); await expireLeases();
    await P.processDuePayouts(app, sim);
    expect(await status(id)).toBe("paid"); expect(sim.transfers.size).toBe(1); expect(sim.calls).toBe(2);
  });
  it("worker crash after provider success (before DB commit) is recovered without a second transfer", async () => {
    const id = await ready("c1", 300n);
    const claimed = await P.claimDue(app, 5); expect(claimed.length).toBe(1);        // worker claims...
    await sim.createTransfer({ payoutId: Number(id), accountId: "acct_c1", amountMinor: 300n, currency: "usd", idempotencyKey: `payout-${id}` }); // ...provider succeeds...
    const callsBefore = sim.calls;                                                    // ...and the worker dies here.
    expect(await status(id)).toBe("processing");
    await expireLeases();
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ paid: 1 });
    expect(sim.calls).toBe(callsBefore); expect(sim.transfers.size).toBe(1);
    expect(await bal(P.PAID)).toBe(300n); await inv();
  });
  it("two concurrent workers over many payouts create exactly one transfer per payout", async () => {
    for (let i = 0; i < 12; i++) await ready("c1", 50n);
    await Promise.all([P.processDuePayouts(app, sim, 12), P.processDuePayouts(app, sim, 12), P.processDuePayouts(app, sim, 12)]);
    await P.processDuePayouts(app, sim, 12);
    expect((await owner.query("SELECT count(*)::int n FROM payouts WHERE status='paid'")).rows[0].n).toBe(12);
    expect(sim.calls).toBe(12); expect(sim.transfers.size).toBe(12);
    expect(await bal(P.PAID)).toBe(600n); expect(await bal(P.CLEARING)).toBe(0n);
    await inv();
  });
  it("repeated uncertainty exhausts attempts into needs_review; admin must resolve; mark_paid needs provider proof", async () => {
    const id = await ready("c1", 300n);
    for (let i = 0; i < 5; i++) { sim.failNext("unknown_before"); await P.processDuePayouts(app, sim); await expireLeases(); }
    expect(await status(id)).toBe("needs_review");
    expect(await bal(P.CLEARING)).toBe(300n);
    await expect(P.resolvePayout(app, sim, id, "mark_paid", "admin1")).rejects.toMatchObject({ code: "provider_transfer_missing" });
    await P.resolvePayout(app, sim, id, "retry", "admin1");
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ paid: 1 });
    expect(sim.transfers.size).toBe(1);
  });
  it("admin cannot fail a payout whose transfer exists at the provider", async () => {
    const id = await ready("c1", 300n);
    await owner.query("UPDATE payouts SET status='processing' WHERE id=$1", [id]);
    await owner.query("UPDATE payouts SET status='needs_review' WHERE id=$1", [id]);
    await sim.createTransfer({ payoutId: Number(id), accountId: "acct_c1", amountMinor: 300n, currency: "usd", idempotencyKey: `payout-${id}` });
    await expect(P.resolvePayout(app, sim, id, "fail", "admin1")).rejects.toMatchObject({ code: "provider_transfer_exists" });
    await P.resolvePayout(app, sim, id, "mark_paid", "admin1");
    expect(await status(id)).toBe("paid"); await inv();
  });
  it("account that is no longer eligible parks the payout for review instead of paying", async () => {
    const id = await ready("c1", 300n);
    sim.accounts.set("acct_c1", { exists: true, verified: true, payoutsEnabled: false });
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ review: 1 });
    expect(await status(id)).toBe("needs_review"); expect(sim.calls).toBe(0);
  });
  it("reconciliation flags provider/ledger disagreements", async () => {
    const id = await ready("c1", 300n); await P.processDuePayouts(app, sim);
    sim.reverse(Number(id));
    const rec = await P.reconcilePayouts(app, sim);
    expect(rec.ok).toBe(false); expect(rec.mismatches).toEqual([{ payoutId: id, issue: "reversed_at_provider_not_locally" }]);
    sim.transfers.clear();
    expect((await P.reconcilePayouts(app, sim)).mismatches[0].issue).toBe("paid_locally_missing_at_provider");
  });
  it("database crash-restart mid-flow loses no reserved funds and the worker completes afterwards", async () => {
    const id = await ready("c1", 300n);
    await P.claimDue(app, 5);
    const { execFileSync } = await import("node:child_process");
    execFileSync("scripts/pg-test.sh", ["crash"], { stdio: "pipe" });
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 20; i++) { try { await owner.query("SELECT 1"); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
    expect(await status(id)).toBe("processing"); expect(await bal(P.CLEARING)).toBe(300n);
    await inv();
    await expireLeases();
    expect(await P.processDuePayouts(app, sim)).toMatchObject({ paid: 1 });
    await inv();
  });
});

describe("holds, debt and clawbacks", () => {
  beforeEach(async () => { await approvePolicy(); await verify("c1"); });
  it("a refund request holds the creator share automatically and releases on decision", async () => {
    const g = await earn("c1", 1000n); // 700 earnings
    await owner.query("INSERT INTO refund_requests(entry_id,requested_by,idempotency_key,reason) VALUES($1,'fan','k','x')", [g.entryId]);
    let a = await P.availability(app, "c1");
    expect([a.held, a.available]).toEqual([700n, 0n]);
    await expect(P.requestPayout(app, sim, { userId: "c1", key: "h", coins: 100n, actor: "c1" })).rejects.toMatchObject({ code: "insufficient_available" });
    await owner.query("UPDATE refund_requests SET status='rejected' WHERE entry_id=$1", [g.entryId]);
    a = await P.availability(app, "c1"); expect(a.available).toBe(700n);
  });
  it("refund after the creator was paid out records debt, never a negative earnings balance", async () => {
    const g = await earn("c1", 1000n);                      // c1: 700
    await ready("c1", 600n); await P.processDuePayouts(app, sim); // paid out 600, 100 left
    await expect(L.reverseEntry(app, { entryId: g.entryId, key: "plain", reason: "r" })).rejects.toThrow(L.InsufficientFundsError); // legacy path unchanged
    const r = await P.reverseWithClawback(app, { entryId: g.entryId, key: "claw", reason: "refund" });
    expect(r.replayed).toBe(false);
    expect(await bal("earnings:c1")).toBe(0n);
    expect(await bal(P.debtId("c1"))).toBe(-600n);          // platform receivable
    expect(await bal("wallet:" + (await owner.query("SELECT account_id FROM postings WHERE entry_id=$1 AND amount<0", [g.entryId])).rows[0].account_id.slice(7))).toBe(1000n);
    await inv();
    expect((await P.availability(app, "c1")).debt).toBe(600n);
    // replay is idempotent
    expect((await P.reverseWithClawback(app, { entryId: g.entryId, key: "claw", reason: "refund" })).replayed).toBe(true);
    // new earnings offset the debt via an explicit ledger entry before any payout
    await earn("c1", 1000n, "t2");                          // +700
    const p2 = await P.requestPayout(app, sim, { userId: "c1", key: "after", coins: 100n, actor: "c1" });
    expect(await bal(P.debtId("c1"))).toBe(0n);
    expect(await bal("earnings:c1")).toBe(0n);              // 700 - 600 debt - 100 payout
    expect((await owner.query("SELECT count(*)::int n FROM journal_entries WHERE type='debt_offset'")).rows[0].n).toBe(1);
    expect(p2.payout.amount_coins).toBe("100");
    await inv();
  });
  it("clawback path is blocked until clawback_mode is approved", async () => {
    const g = await earn("c1", 1000n);
    await owner.query("BEGIN; SELECT set_config('xtc.policy_fn','on',true); UPDATE accounting_policy SET value=NULL, approved_by=NULL, approved_at=NULL WHERE key='clawback_mode'; COMMIT");
    await expect(P.reverseWithClawback(app, { entryId: g.entryId, key: "c", reason: "r" })).rejects.toThrow(P.PolicyNotApprovedError);
  });
  it("frozen wallets cannot spend but can receive reversals", async () => {
    await L.creditPurchase(app, { userId: "fz", coins: 500n, provider: "simulation", providerTxId: "fz1" });
    await owner.query("UPDATE ledger_accounts SET frozen=true WHERE id='wallet:fz'");
    await expect(L.sendGift(app, { giftId: "fg", fromUser: "fz", creatorId: "c1", coins: 100n })).rejects.toThrow(L.AccountFrozenError);
    expect(await bal("wallet:fz")).toBe(500n);
    const rev = await L.reverseEntry(app, { entryId: (await owner.query("SELECT id FROM journal_entries WHERE idempotency_key='purchase:simulation:fz1'")).rows[0].id, key: "fzrev", reason: "chargeback" });
    expect(rev.replayed).toBe(false); expect(await bal("wallet:fz")).toBe(0n);
    await inv();
  });
});

describe("database privileges for payout objects", () => {
  it("runtime role cannot tamper with holds, history or policy; frontend role sees nothing", async () => {
    await approvePolicy();
    await expect(app.query("INSERT INTO payout_holds(user_id,kind,amount) VALUES('c1','admin',1)")).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE payout_events SET to_status='paid'")).rejects.toThrow(/permission denied/);
    await expect(app.query("INSERT INTO payout_events(payout_id,to_status) VALUES(1,'paid')")).rejects.toThrow(/permission denied/);
    const fe = new PgDb(TEST_URL, 2, "xtc_authenticated");
    for (const t of ["payouts", "payout_events", "payout_holds", "payout_profiles", "accounting_policy"]) await expect(fe.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/);
    await fe.close();
  });
});
