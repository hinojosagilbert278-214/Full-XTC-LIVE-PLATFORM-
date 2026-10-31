import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgDb } from "../../src/db/pg";
import * as L from "../../src/ledger/ledger";
import * as P from "../../src/payouts/service";
import { SimulatedProvider } from "../../src/payouts/provider";
import { freshDb, TEST_URL } from "./helper";

let owner: PgDb, app: PgDb, admin: PgDb, sim: SimulatedProvider;
const POLICY: Record<string, string> = { hold_days: "0", coin_value_usd_micros: "10000", min_payout_coins: "10", review_threshold_coins: "1000", clawback_mode: "debt" };
const wipe = (db: PgDb) => db.query(`BEGIN; SELECT set_config('xtc.allow_destructive','on',true);
  TRUNCATE postings, journal_entries, ledger_accounts, audit_log, payouts, payout_events, payout_holds, payout_profiles, refund_requests, policy_proposals RESTART IDENTITY CASCADE; COMMIT`);
async function approveAll() {
  for (const [k, v] of Object.entries(POLICY)) {
    const id = (await admin.query("SELECT propose_policy($1,$2,'alice') id", [k, v])).rows[0].id;
    await admin.query("SELECT approve_policy_proposal($1,'bob')", [id]);
  }
}
beforeAll(async () => { owner = await freshDb(); app = new PgDb(TEST_URL, 10, "xtc_app"); admin = new PgDb(TEST_URL, 3, "xtc_admin"); });
afterAll(async () => { await owner.close(); await app.close(); await admin.close(); });
beforeEach(async () => {
  await wipe(owner);
  await owner.query("BEGIN; SELECT set_config('xtc.policy_fn','on',true); UPDATE accounting_policy SET value=NULL, approved_by=NULL, approved_at=NULL, proposed_by=NULL, version=0; COMMIT");
  sim = new SimulatedProvider();
});
async function earn(creator: string, gross: bigint, tag: string, fam?: { id: string; bps: number }) {
  await L.creditPurchase(app, { userId: `fan-${tag}`, coins: gross, provider: "simulation", providerTxId: `p-${tag}` });
  return L.sendGift(app, { giftId: `g-${tag}`, fromUser: `fan-${tag}`, creatorId: creator, coins: gross, familyId: fam?.id, familyBps: fam?.bps });
}
const verify = (u: string) => owner.query(`INSERT INTO payout_profiles(user_id,provider_account_id,verification_status,payouts_enabled) VALUES($1,$2,'verified',true) ON CONFLICT (user_id) DO NOTHING`, [u, `acct_${u}`]);
const sumAll = async () => (await owner.query("SELECT COALESCE(SUM(amount),0)::text s FROM postings")).rows[0].s;

describe("R1 four-eyes policy approval", () => {
  it("proposer cannot approve; a second admin can; both actors, timestamps, version and value are recorded", async () => {
    const id = (await admin.query("SELECT propose_policy('hold_days','7','alice') id")).rows[0].id;
    await expect(admin.query("SELECT approve_policy_proposal($1,'alice')", [id])).rejects.toThrow(/four-eyes/);
    expect((await owner.query("SELECT value FROM accounting_policy WHERE key='hold_days'")).rows[0].value).toBeNull();
    await admin.query("SELECT approve_policy_proposal($1,'bob')", [id]);
    const h = (await owner.query("SELECT * FROM accounting_policy_history WHERE key='hold_days'")).rows[0];
    expect(h).toMatchObject({ new_value: "7", actor: "bob", proposed_by: "alice", version: 1 });
    expect(h.proposed_at).toBeTruthy(); expect(h.at ?? h.approved_at ?? h.created_at).toBeTruthy();
    const pr = (await owner.query("SELECT * FROM policy_proposals WHERE id=$1", [id])).rows[0];
    expect(pr).toMatchObject({ status: "approved", proposed_by: "alice", decided_by: "bob" });
    await expect(admin.query("SELECT approve_policy_proposal($1,'carol')", [id])).rejects.toThrow(/not pending/);
  });
  it("the table itself refuses a self-approval even if the function is bypassed", async () => {
    const id = (await admin.query("SELECT propose_policy('hold_days','7','alice') id")).rows[0].id;
    await expect(owner.query("UPDATE policy_proposals SET status='approved', decided_by='alice', decided_at=now() WHERE id=$1", [id])).rejects.toThrow(/check constraint/);
  });
  it("policy values cannot be changed outside the approval function, and invalid values are rejected", async () => {
    await expect(owner.query("UPDATE accounting_policy SET value='1' WHERE key='hold_days'")).rejects.toThrow(/approve_policy_proposal/);
    await expect(admin.query("SELECT propose_policy('hold_days','-3','alice')")).rejects.toThrow(/invalid value/);
    await expect(admin.query("SELECT propose_policy('coin_value_usd_micros','0','alice')")).rejects.toThrow(/invalid value/);
    await expect(app.query("SELECT propose_policy('hold_days','1','mallory')")).rejects.toThrow(/permission denied/);
    await expect(app.query("SELECT approve_policy_proposal(1,'mallory')")).rejects.toThrow(/permission denied/);
    await expect(app.query("SELECT approve_policy('hold_days','1','x')")).rejects.toThrow(/does not exist/);
  });
  it("a new proposal supersedes the pending one", async () => {
    const a = (await admin.query("SELECT propose_policy('hold_days','3','alice') id")).rows[0].id;
    await admin.query("SELECT propose_policy('hold_days','4','alice')");
    expect((await owner.query("SELECT status FROM policy_proposals WHERE id=$1", [a])).rows[0].status).toBe("superseded");
  });
});

describe("R2 provider evidence required for 'paid'", () => {
  beforeEach(async () => { await approveAll(); await verify("c1"); });
  async function inReview(): Promise<number> {
    await earn("c1", 1000n, "a");
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "k1", coins: 100n, actor: "c1" });
    const id = Number(r.payout.id);
    await owner.query("UPDATE payouts SET status='queued' WHERE id=$1 AND status='pending_review'", [id]);
    await owner.query("UPDATE payouts SET status='processing' WHERE id=$1", [id]);
    await owner.query("UPDATE payouts SET status='needs_review' WHERE id=$1", [id]);
    return id;
  }
  it("needs_review -> paid is refused by the database without evidence, even for the table owner", async () => {
    const id = await inReview();
    await expect(owner.query("UPDATE payouts SET status='paid', provider_ref='tr_fake' WHERE id=$1", [id])).rejects.toThrow(/without matching provider evidence/);
  });
  it("evidence must match provider, ref and amount, and an admin-asserted create_response is not enough from needs_review", async () => {
    const id = await inReview();
    await owner.query("INSERT INTO payout_provider_evidence(payout_id,provider,provider_ref,amount_minor,currency,source) VALUES($1,'simulated','tr_1',1,'usd','provider_lookup')", [id]);
    await expect(owner.query("UPDATE payouts SET status='paid', provider_ref='tr_1' WHERE id=$1", [id])).rejects.toThrow(/provider evidence/); // wrong amount
    await expect(owner.query("UPDATE payout_provider_evidence SET amount_minor=1000 WHERE payout_id=$1", [id])).rejects.toThrow(/append-only/);
  });
  it("create_response evidence cannot rescue a needs_review payout", async () => {
    const id = await inReview();
    const p = (await owner.query("SELECT provider, amount_minor, currency FROM payouts WHERE id=$1", [id])).rows[0];
    await owner.query("INSERT INTO payout_provider_evidence(payout_id,provider,provider_ref,amount_minor,currency,source) VALUES($1,$2,'tr_2',$3,$4,'create_response')", [id, p.provider, p.amount_minor, p.currency]);
    await expect(owner.query("UPDATE payouts SET status='paid', provider_ref='tr_2' WHERE id=$1", [id])).rejects.toThrow(/lookup\/webhook evidence/);
  });
  it("the service path (lookup evidence + settle entry) succeeds from needs_review", async () => {
    const id = await inReview();
    await sim.createTransfer({ payoutId: id, accountId: "acct_c1", amountMinor: 1000n, currency: "usd", idempotencyKey: `payout-${id}` });
    const p = await P.resolvePayout(app, sim, id, "mark_paid", "admin1");
    expect(p.status).toBe("paid");
    expect((await owner.query("SELECT source FROM payout_provider_evidence WHERE payout_id=$1", [id])).rows[0].source).toBe("provider_lookup");
  });
  it("the app role cannot forge evidence rows for other tables or delete them", async () => {
    await expect(app.query("DELETE FROM payout_provider_evidence")).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE payout_provider_evidence SET source='provider_webhook'")).rejects.toThrow(/permission denied/);
  });
});

describe("R3 payout <-> ledger linkage", () => {
  beforeEach(async () => { await approveAll(); await verify("c1"); });
  it("every service-created payout is linked to exactly its ledger entries", async () => {
    await earn("c1", 1000n, "a");
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "k1", coins: 100n, actor: "c1" });
    let p = (await owner.query("SELECT * FROM payouts WHERE id=$1", [r.payout.id])).rows[0];
    expect(p.reserve_entry).not.toBeNull(); expect(p.settle_entry).toBeNull();
    await P.reviewPayout(app, r.payout.id, "approve", "admin1");
    await P.processDuePayouts(app, sim);
    p = (await owner.query("SELECT * FROM payouts WHERE id=$1", [r.payout.id])).rows[0];
    expect(p.status).toBe("paid"); expect(p.settle_entry).not.toBeNull();
  });
  it("a payout cannot be committed without its reserve entry", async () => {
    await expect(owner.query(`INSERT INTO payouts(user_id,idempotency_key,amount_coins,amount_minor,currency,rate_micros,status,provider,provider_account_id)
      VALUES('c1','forged',100,100,'usd',10000,'queued','simulated','acct_c1')`)).rejects.toThrow(/lacks a matching reserve/);
  });
  it("a status cannot be forged: 'failed' without a return entry is refused at commit", async () => {
    await earn("c1", 1000n, "a");
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "k1", coins: 100n, actor: "c1" });
    await owner.query("UPDATE payouts SET status='queued' WHERE id=$1", [r.payout.id]);
    await expect(owner.query("UPDATE payouts SET status='cancelled' WHERE id=$1", [r.payout.id])).rejects.toThrow(/lacks a matching return/);
    expect((await owner.query("SELECT status FROM payouts WHERE id=$1", [r.payout.id])).rows[0].status).toBe("queued");
  });
  it("linking a payout to an entry with the wrong postings is refused", async () => {
    await earn("c1", 1000n, "a");
    const r = await P.requestPayout(app, sim, { userId: "c1", key: "k1", coins: 100n, actor: "c1" });
    const other = await earn("c1", 1000n, "b");
    await expect(owner.query("UPDATE payouts SET reserve_entry=$2 WHERE id=$1", [r.payout.id, other.entryId])).rejects.toThrow(/immutable|reserve ledger/);
  });
  it("ledger movements on payout accounts without a payout record are refused", async () => {
    await earn("c1", 1000n, "a");
    await L.ensureAccount(app, "payout:clearing", "payout_clearing");
    await expect(L.postEntry(app, { key: "orphan", type: "payout_reserve", postings: [{ account: L.earningsId("c1"), amount: -50n }, { account: "payout:clearing", amount: 50n }] })).rejects.toThrow(/without a payout record/);
    await expect(L.postEntry(app, { key: "orphan2", type: "gift", postings: [{ account: L.earningsId("c1"), amount: -50n }, { account: "payout:clearing", amount: 50n }] })).rejects.toThrow(/without a payout record/);
    expect(await sumAll()).toBe("0");
  });
});

describe("R4 refund and chargeback holds cover creator and family earnings", () => {
  beforeEach(async () => { await approveAll(); await verify("c1"); });
  it("refund request holds both shares; completion consumes them with an entry link; events are append-only", async () => {
    const g = await earn("c1", 1000n, "a", { id: "f1", bps: 1000 }); // creator 700 -> family 70, creator keeps 630
    const fa0 = await P.familyAvailability(app, "f1"); expect(fa0.balance).toBe(70n);
    await owner.query("INSERT INTO refund_requests(entry_id,requested_by,idempotency_key,reason) VALUES($1,'fan','k','x')", [g.entryId]);
    const holds = (await owner.query("SELECT account_id, amount::text, status FROM payout_holds ORDER BY account_id")).rows;
    expect(holds).toEqual([{ account_id: "earnings:c1", amount: "630", status: "active" }, { account_id: "family:f1", amount: "70", status: "active" }]);
    expect((await P.familyAvailability(app, "f1")).available).toBe(0n);
    expect((await P.availability(app, "c1")).available).toBe(0n);
    const rev = await L.reverseEntry(app, { entryId: g.entryId, key: "rev1", reason: "refund" });
    await owner.query("UPDATE refund_requests SET status='completed', reversal_entry=$2 WHERE entry_id=$1", [g.entryId, rev.entryId]);
    expect((await owner.query("SELECT DISTINCT status, settled_entry::text FROM payout_holds")).rows).toEqual([{ status: "consumed", settled_entry: String(rev.entryId) }]);
    const ev = (await owner.query("SELECT action, count(*)::int n FROM payout_hold_events GROUP BY action ORDER BY action")).rows;
    expect(ev).toEqual([{ action: "consumed", n: 2 }, { action: "created", n: 2 }]);
    await expect(owner.query("DELETE FROM payout_hold_events")).rejects.toThrow(/append-only/);
    await expect(owner.query("UPDATE payout_holds SET status='active'")).rejects.toThrow(/already consumed/);
  });
  it("a rejected refund releases both holds", async () => {
    const g = await earn("c1", 1000n, "a", { id: "f1", bps: 1000 });
    await owner.query("INSERT INTO refund_requests(entry_id,requested_by,idempotency_key,reason) VALUES($1,'fan','k','x')", [g.entryId]);
    await owner.query("UPDATE refund_requests SET status='rejected' WHERE entry_id=$1", [g.entryId]);
    expect((await owner.query("SELECT DISTINCT status FROM payout_holds")).rows).toEqual([{ status: "released" }]);
    expect((await P.familyAvailability(app, "f1")).available).toBe(70n);
  });
  it("a chargeback of spent coins holds the newest gifts' shares for creator and family, idempotently", async () => {
    await L.creditPurchase(app, { userId: "fan", coins: 1000n, provider: "stripe", providerTxId: "tx1" });
    const pe = Number((await owner.query("SELECT id FROM journal_entries WHERE idempotency_key='purchase:stripe:tx1'")).rows[0].id);
    await L.sendGift(app, { giftId: "gA", fromUser: "fan", creatorId: "c1", coins: 600n, familyId: "f1", familyBps: 1000 });
    await L.sendGift(app, { giftId: "gB", fromUser: "fan", creatorId: "c2", coins: 400n });
    expect((await owner.query("SELECT place_chargeback_holds($1) n", [pe])).rows[0].n).toBeGreaterThan(0);
    const again = (await owner.query("SELECT place_chargeback_holds($1) n", [pe])).rows[0].n; expect(again).toBe(0);
    const held = (await owner.query("SELECT account_id, sum(amount)::text s FROM payout_holds WHERE kind='chargeback' AND status='active' GROUP BY 1 ORDER BY 1")).rows;
    expect(held).toEqual([{ account_id: "earnings:c1", s: "378" }, { account_id: "earnings:c2", s: "280" }, { account_id: "family:f1", s: "42" }]);
    expect((await P.availability(app, "c2")).available).toBe(0n);
  });
  it("a chargeback whose coins are still in the wallet creates no holds", async () => {
    await L.creditPurchase(app, { userId: "fan", coins: 1000n, provider: "stripe", providerTxId: "tx2" });
    const pe = Number((await owner.query("SELECT id FROM journal_entries WHERE idempotency_key='purchase:stripe:tx2'")).rows[0].id);
    expect((await owner.query("SELECT place_chargeback_holds($1) n", [pe])).rows[0].n).toBe(0);
  });
  it("family debt is recorded by the clawback and repaid by an explicit offset entry", async () => {
    const g = await earn("c1", 1000n, "a", { id: "f1", bps: 1000 });
    // Family spends nothing today; simulate a shortfall by reversing after a family-side debit entry.
    await L.ensureAccount(app, "platform:revenue", "platform_revenue");
    await L.postEntry(app, { key: "famdrain", type: "adjustment", postings: [{ account: L.familyId("f1"), amount: -70n }, { account: "platform:revenue", amount: 70n }] });
    await P.reverseWithClawback(app, { entryId: g.entryId, key: "claw", reason: "refund" });
    expect((await P.familyAvailability(app, "f1")).debt).toBe(70n);
    await earn("c9", 1000n, "b", { id: "f1", bps: 1000 });
    const r = await P.offsetFamilyDebt(app, "f1", "k1");
    expect(r.offset).toBe(70n);
    expect((await P.offsetFamilyDebt(app, "f1", "k1")).offset).toBe(0n);
    expect(await sumAll()).toBe("0");
  });
});

describe("R5 schema and destructive-operation guards", () => {
  it("TRUNCATE of ledger tables is blocked unless the explicit tooling flag is set", async () => {
    await expect(owner.query("TRUNCATE postings CASCADE")).rejects.toThrow(/TRUNCATE .* is blocked/);
    await expect(owner.query("TRUNCATE ddl_audit")).rejects.toThrow(/blocked/);
  });
  it("trigger, function and table changes are blocked outside migrations", async () => {
    await expect(owner.query("ALTER TABLE journal_entries DISABLE TRIGGER USER")).rejects.toThrow(/blocked outside migrations/);
    await expect(owner.query("DROP TRIGGER payouts_guard_trg ON payouts").catch((e) => { throw e; })).rejects.toThrow(/blocked outside migrations|does not exist/);
    await expect(owner.query("CREATE OR REPLACE FUNCTION payouts_guard() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql")).rejects.toThrow(/blocked outside migrations/);
    await expect(owner.query("ALTER TABLE payouts DROP COLUMN reserve_entry")).rejects.toThrow(/blocked outside migrations/);
  });
  it("application and admin roles hold no TRIGGER/TRUNCATE privileges on financial tables", async () => {
    const r = await owner.query(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee IN ('xtc_app','xtc_admin','xtc_readonly','xtc_authenticated') AND privilege_type IN ('TRIGGER','TRUNCATE','REFERENCES')`);
    expect(r.rows).toEqual([]);
    await expect(app.query("DROP TABLE postings")).rejects.toThrow(/must be owner|blocked outside migrations/);
    await expect(app.query("TRUNCATE postings")).rejects.toThrow(/permission denied/);
  });
  it("migrations are re-appliable and every run is recorded in ddl_audit", async () => {
    const { migrate } = await import("../../src/db/pg");
    const before = (await owner.query("SELECT count(*)::int n FROM ddl_audit")).rows[0].n;
    await migrate(owner);
    expect((await owner.query("SELECT count(*)::int n FROM ddl_audit")).rows[0].n).toBe(before + 1);
    await expect(owner.query("UPDATE ddl_audit SET actor='x'")).rejects.toThrow(/append-only/);
  });
});
