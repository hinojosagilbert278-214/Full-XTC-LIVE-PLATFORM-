/**
 * Migration 008 adversarial tests. Every control is attacked by (a) the ordinary application login (t_app / t_worker)
 * and (b) a privileged NON-superuser (dba_np: CREATEROLE/CREATEDB, xtc_admin member, temporary table owner).
 * What a PostgreSQL superuser can still do is documented in docs/SECURITY.md and is deliberately not claimed to be prevented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgDb } from "../../src/db/pg";
import * as L from "../../src/ledger/ledger";
import * as P from "../../src/payouts/service";
import { SimulatedProvider } from "../../src/payouts/provider";
import { approvePolicies, asLogin, freshDb, loginDb, resetPolicies } from "./helper";

let owner: PgDb, app: PgDb, worker: PgDb, dba: PgDb, sim: SimulatedProvider;
const POLICY: Record<string, string> = { hold_days: "0", coin_value_usd_micros: "10000", min_payout_coins: "10", review_threshold_coins: "100000", clawback_mode: "debt" };
const wipe = (db: PgDb) => db.query(`BEGIN; TRUNCATE postings, journal_entries, ledger_accounts, audit_log, payouts, payout_events, payout_holds, payout_profiles, refund_requests, policy_proposals, webhook_events RESTART IDENTITY CASCADE; COMMIT`);

/** Asserts a rejection whose SQLSTATE is one of the given codes (42501 = permission denied is always acceptable for the plain app login). */
async function rejected(p: Promise<unknown>, ...codes: string[]) {
  let err: any;
  try { await p; } catch (e) { err = e; }
  expect(err, "operation was unexpectedly allowed").toBeDefined();
  expect(codes, `unexpected error ${err?.code}: ${err?.message}`).toContain(err.code);
}
/** Makes dba_np (privileged, not superuser) the temporary owner of the tables, then restores ownership. */
async function asOwner<T>(tables: string[], fn: (c: PgDb) => Promise<T>): Promise<T> {
  for (const t of tables) await owner.query(`ALTER TABLE ${t} OWNER TO dba_np`);
  try { return await fn(dba); } finally { for (const t of tables) await owner.query(`ALTER TABLE ${t} OWNER TO xtc`); }
}
async function earn(creator: string, gross: bigint, tag: string, fam?: { id: string; bps: number }) {
  await L.creditPurchase(app, { userId: `fan-${tag}`, coins: gross, provider: "stripe", providerTxId: `p-${tag}` });
  return L.sendGift(app, { giftId: `g-${tag}`, fromUser: `fan-${tag}`, creatorId: creator, coins: gross, familyId: fam?.id, familyBps: fam?.bps });
}
const verify = (u: string) => owner.query(`INSERT INTO payout_profiles(user_id,provider_account_id,verification_status,payouts_enabled) VALUES($1,$2,'verified',true) ON CONFLICT (user_id) DO NOTHING`, [u, `acct_${u}`]);
async function chargebackEvent(txId: string, kind = "chargeback") {
  return Number((await owner.query(`INSERT INTO webhook_events(provider,event_id,kind,ledger_provider,provider_tx_id,raw_body) VALUES('stripe',$1,$2,'stripe',$3,'{}') RETURNING id`, [`evt-${txId}-${Math.random()}`, kind, txId])).rows[0].id);
}
const sumAll = async () => (await owner.query("SELECT COALESCE(SUM(amount),0)::text s FROM postings")).rows[0].s;

beforeAll(async () => { owner = await freshDb(); app = loginDb("t_app", 10); worker = loginDb("t_worker", 10); dba = loginDb("dba_np", 5); });
afterAll(async () => { await owner.close(); await app.close(); await worker.close(); await dba.close(); });
beforeEach(async () => { await wipe(owner); await resetPolicies(owner); sim = new SimulatedProvider(); });

/** A payout stuck in needs_review (provider outcome unknown) for evidence tests. */
async function needsReview(): Promise<{ id: number; p: any }> {
  await approvePolicies(POLICY); await verify("c1"); await earn("c1", 1000n, "a");
  const r = await P.requestPayout(worker, sim, { userId: "c1", key: "k1", coins: 100n, actor: "c1" });
  const id = Number(r.payout.id);
  await owner.query("UPDATE payouts SET status='queued' WHERE id=$1 AND status='pending_review'", [id]);
  await owner.query("UPDATE payouts SET status='processing' WHERE id=$1", [id]);
  await owner.query("UPDATE payouts SET status='needs_review' WHERE id=$1", [id]);
  return { id, p: (await owner.query("SELECT provider, amount_minor, currency FROM payouts WHERE id=$1", [id])).rows[0] };
}
const ev = (c: PgDb, id: number, p: any, ref: string, source: string, v?: object) =>
  c.query("SELECT record_provider_evidence($1,$2,$3,$4,$5,$6,$7::jsonb)", [id, p.provider, ref, p.amount_minor, p.currency, source, JSON.stringify(v ?? (source === "provider_lookup" ? { transfer_group: `payout-${id}` } : { idempotency_key: `payout-${id}` }))]);

describe("A. provider evidence cannot be forged by the application", () => {
  it("app login: direct INSERT and the ingestion function are both denied", async () => {
    const { id, p } = await needsReview();
    await rejected(app.query("INSERT INTO payout_provider_evidence(payout_id,provider,provider_ref,amount_minor,currency,source,observation_ref,recorded_by) VALUES($1,$2,'tr_x',$3,$4,'provider_lookup','o',session_user)", [id, p.provider, p.amount_minor, p.currency]), "42501");
    await rejected(ev(app, id, p, "tr_x", "provider_lookup"), "42501");
    await rejected(app.query("UPDATE payouts SET status='paid', provider_ref='tr_x' WHERE id=$1", [id]), "42501", "P0432", "P0422");
  });
  it("worker login may call the function but not INSERT directly", async () => {
    const { id, p } = await needsReview();
    await rejected(worker.query("INSERT INTO payout_provider_evidence(payout_id,provider,provider_ref,amount_minor,currency,source,observation_ref,recorded_by) VALUES($1,$2,'tr_x',$3,$4,'provider_lookup','o','t_worker')", [id, p.provider, p.amount_minor, p.currency]), "42501");
  });
  it("privileged non-superuser: no EXECUTE, no INSERT, and even as table OWNER the trigger demands the worker identity", async () => {
    const { id, p } = await needsReview();
    await rejected(ev(dba, id, p, "tr_x", "provider_lookup"), "42501");
    await rejected(dba.query("INSERT INTO payout_provider_evidence(payout_id,provider,provider_ref,amount_minor,currency,source,observation_ref,recorded_by) VALUES($1,$2,'tr_x',$3,$4,'provider_lookup','o','dba_np')", [id, p.provider, p.amount_minor, p.currency]), "42501");
    await asOwner(["payout_provider_evidence", "payouts"], async (c) => {
      await rejected(c.query("INSERT INTO payout_provider_evidence(payout_id,provider,provider_ref,amount_minor,currency,source,observation_ref,verification,recorded_by) VALUES($1,$2,'tr_x',$3,$4,'provider_lookup','o',$5,'t_worker')", [id, p.provider, p.amount_minor, p.currency, JSON.stringify({ transfer_group: `payout-${id}` })]), "P0433");
      await rejected(c.query("UPDATE payouts SET status='paid', provider_ref='tr_x' WHERE id=$1", [id]), "P0432");
    });
  });
  it("the worker cannot record webhook-sourced evidence (no verified ingestion path) or evidence lacking correlation metadata", async () => {
    const { id, p } = await needsReview();
    await rejected(ev(worker, id, p, "tr_1", "provider_webhook", { transfer_group: `payout-${id}` }), "P0433");
    await rejected(ev(worker, id, p, "tr_1", "provider_lookup", {}), "P0433");
    await rejected(ev(worker, id, p, "tr_1", "provider_lookup", { transfer_group: "payout-999" }), "P0433");
    await rejected(ev(worker, id, p, "tr_1", "create_response", { idempotency_key: "other" }), "P0433");
    await rejected(worker.query("SELECT record_provider_evidence($1,$2,'tr_1',$3,$4,'provider_lookup',$5::jsonb)", [id, p.provider, 1n, p.currency, JSON.stringify({ transfer_group: `payout-${id}` })]), "P0433");
  });
  it("evidence history: multiple immutable observations; duplicates are idempotent; conflicting references are refused", async () => {
    const { id, p } = await needsReview();
    await ev(worker, id, p, "tr_1", "create_response");
    await ev(worker, id, p, "tr_1", "provider_lookup");
    await ev(worker, id, p, "tr_1", "provider_lookup"); // duplicate observation
    expect(Number((await owner.query("SELECT count(*) n FROM payout_provider_evidence WHERE payout_id=$1", [id])).rows[0].n)).toBeGreaterThanOrEqual(2);
    await rejected(ev(worker, id, p, "tr_2", "provider_lookup"), "P0434"); // different ref, same payout
    await rejected(owner.query("UPDATE payout_provider_evidence SET provider_ref='tr_9' WHERE payout_id=$1", [id]), "P0001", "P0403", "P0420", "55000");
    await rejected(owner.query("DELETE FROM payout_provider_evidence WHERE payout_id=$1", [id]), "P0001", "P0403", "P0420", "55000");
    await asOwner(["payout_provider_evidence"], (c) => rejected(c.query("DELETE FROM payout_provider_evidence"), "P0001", "P0403", "P0420", "55000"));
  });
  it("a provider reference already attributed to one payout cannot be replayed against another", async () => {
    const { id, p } = await needsReview();
    await ev(worker, id, p, "tr_1", "provider_lookup");
    await earn("c1", 1000n, "b");
    const r2 = await P.requestPayout(worker, sim, { userId: "c1", key: "k2", coins: 100n, actor: "c1" });
    const id2 = Number(r2.payout.id);
    await owner.query("UPDATE payouts SET status='queued' WHERE id=$1 AND status='pending_review'", [id2]);
    await rejected(ev(worker, id2, p, "tr_1", "provider_lookup"), "P0433", "P0434");
  });
});

describe("B. only approved initial payout states", () => {
  const cols = "user_id,idempotency_key,amount_coins,amount_minor,currency,rate_micros,provider,provider_account_id";
  const vals = "'c1','direct',100,1000,'usd',10000,'stripe','acct_c1'";
  it("app login cannot insert a payout directly at all, and never as paid", async () => {
    await approvePolicies(POLICY); await verify("c1");
    await rejected(app.query(`INSERT INTO payouts(${cols},status) VALUES(${vals},'paid')`), "42501", "P0435");
    await rejected(worker.query(`INSERT INTO payouts(${cols},status,provider_ref) VALUES(${vals},'paid','tr_forged')`), "42501", "P0435");
  });
  it("table owner (non-superuser) is refused paid / settled / provider_ref / leased initial rows", async () => {
    await approvePolicies(POLICY); await verify("c1");
    await asOwner(["payouts"], async (c) => {
      for (const s of ["paid", "processing", "needs_review", "failed", "reversed", "return_pending"]) {
        await rejected(c.query(`INSERT INTO payouts(${cols},status) VALUES(${vals},'${s}')`), "P0435", "23514");
      }
      await rejected(c.query(`INSERT INTO payouts(${cols},status,provider_ref) VALUES(${vals},'queued','tr_pre')`), "P0435");
      await rejected(c.query(`INSERT INTO payouts(${cols},status,attempts) VALUES(${vals},'queued',3)`), "P0435");
    });
  });
});

describe("C. policy table has no caller-controlled bypass", () => {
  it("setting xtc.policy_fn (or any xtc.* flag) does nothing: app, policy admin and owner-level attackers are all refused", async () => {
    await approvePolicies({ hold_days: "5" });
    const attack = (c: PgDb) => c.pool.connect().then(async (cl) => {
      try { await cl.query("SET xtc.policy_fn='on'; SET xtc.migrating='on'; SET xtc.allow_destructive='on'"); await cl.query("UPDATE accounting_policy SET value='0', version=version+1 WHERE key='hold_days'"); }
      finally { cl.release(); }
    });
    await rejected(attack(app), "42501");
    await rejected(attack(dba), "42501");
    await rejected(asLogin("policy_alice", async (c) => { await c.query("SET xtc.policy_fn='on'"); await c.query("UPDATE accounting_policy SET value='0' WHERE key='hold_days'"); }), "42501");
    await asOwner(["accounting_policy"], async (c) => {
      await rejected(attack(c), "P0403");
      await rejected(c.query("INSERT INTO accounting_policy(key,value) VALUES('rogue','1')"), "P0403");
      await rejected(c.query("DELETE FROM accounting_policy WHERE key='hold_days'"), "P0403");
    });
    expect((await owner.query("SELECT value FROM accounting_policy WHERE key='hold_days'")).rows[0].value).toBe("5");
  });
  it("a direct update that copies a real approved value but not its proposal, or replays a used proposal, is refused", async () => {
    await approvePolicies({ hold_days: "5" });
    await asOwner(["accounting_policy"], async (c) => {
      await rejected(c.query("UPDATE accounting_policy SET value='6', version=version+1 WHERE key='hold_days'"), "P0403");
      await rejected(c.query("UPDATE accounting_policy SET value='5', version=version+1 WHERE key='hold_days'"), "P0403"); // proposal already used
    });
  });
});

describe("D. four-eyes identity comes from the authenticated login", () => {
  it("the proposer cannot approve or reject their own proposal", async () => {
    const id = (await asLogin("policy_alice", (c) => c.query("SELECT propose_policy('hold_days','3') id"))).rows[0].id;
    await rejected(asLogin("policy_alice", (c) => c.query("SELECT approve_policy_proposal($1)", [id])), "P0403");
    expect((await owner.query("SELECT status FROM policy_proposals WHERE id=$1", [id])).rows[0].status).toBe("pending");
  });
  it("app, worker and privileged non-superuser cannot propose/approve and cannot become a policy admin", async () => {
    for (const u of ["t_app", "t_worker", "t_admin", "dba_np"]) {
      await rejected(asLogin(u, (c) => c.query("SELECT propose_policy('hold_days','3')")), "42501");
      await rejected(asLogin(u, (c) => c.query("SET ROLE xtc_policy_admin")), "42501");
      await rejected(asLogin(u, (c) => c.query("SET SESSION AUTHORIZATION policy_bob")), "42501");
      await rejected(asLogin(u, (c) => c.query("SET ROLE policy_bob")), "42501");
    }
  });
  it("a policy admin cannot impersonate a colleague: SET ROLE / SET SESSION AUTHORIZATION fail, and forged identity columns are refused", async () => {
    const id = (await asLogin("policy_alice", (c) => c.query("SELECT propose_policy('hold_days','3') id"))).rows[0].id;
    await rejected(asLogin("policy_alice", (c) => c.query("SET ROLE policy_bob")), "42501");
    await rejected(asLogin("policy_alice", (c) => c.query("SET SESSION AUTHORIZATION policy_bob")), "42501");
    await asOwner(["policy_proposals"], async (c) => {
      await rejected(c.query("INSERT INTO policy_proposals(key,value,proposed_by) VALUES('hold_days','4','policy_bob')"), "P0403"); // dba_np is no policy admin
      await rejected(c.query("UPDATE policy_proposals SET status='approved', decided_by='policy_bob', decided_at=now() WHERE id=$1", [id]), "P0403");
      await rejected(c.query("UPDATE policy_proposals SET value='0' WHERE id=$1", [id]), "P0403");
      await rejected(c.query("DELETE FROM policy_proposals WHERE id=$1", [id]), "P0403");
    });
    // a policy admin with owner-level access still cannot write another admin's name or self-approve
    await owner.query("GRANT UPDATE, INSERT ON policy_proposals TO policy_alice; GRANT USAGE ON SEQUENCE policy_proposals_id_seq TO policy_alice");
    try {
      await rejected(asLogin("policy_alice", (c) => c.query("UPDATE policy_proposals SET status='approved', decided_by='policy_bob', decided_at=now() WHERE id=$1", [id])), "P0403");
      await rejected(asLogin("policy_alice", (c) => c.query("UPDATE policy_proposals SET status='approved', decided_by='policy_alice', decided_at=now() WHERE id=$1", [id])), "P0403");
      await rejected(asLogin("policy_alice", (c) => c.query("INSERT INTO policy_proposals(key,value,proposed_by) VALUES('hold_days','4','policy_bob')")), "P0403");
    } finally { await owner.query("REVOKE UPDATE, INSERT ON policy_proposals FROM policy_alice; REVOKE USAGE ON SEQUENCE policy_proposals_id_seq FROM policy_alice"); }
  });
  it("an approval needs two different logins and records both, with timestamps and version", async () => {
    await approvePolicies({ hold_days: "9" });
    const h = (await owner.query("SELECT proposed_by, actor, version, new_value, proposed_at, at FROM accounting_policy_history WHERE key='hold_days'")).rows[0];
    expect(h).toMatchObject({ proposed_by: "policy_alice", actor: "policy_bob", version: 1, new_value: "9" });
    expect(h.at && h.proposed_at).toBeTruthy();
    const id = (await owner.query("SELECT id FROM policy_proposals WHERE key='hold_days'")).rows[0].id;
    await rejected(asLogin("policy_carol", (c) => c.query("SELECT approve_policy_proposal($1)", [id])), "P0001"); // already decided
  });
});

describe("E. proposal concurrency", () => {
  it("simultaneous proposals for one key leave exactly one pending proposal", async () => {
    const pool = loginDb("policy_alice", 12);
    try {
      await Promise.all(Array.from({ length: 12 }, (_, i) => pool.query("SELECT propose_policy('hold_days',$1)", [String(i)]).catch(() => undefined)));
    } finally { await pool.close(); }
    expect(Number((await owner.query("SELECT count(*) n FROM policy_proposals WHERE key='hold_days' AND status='pending'")).rows[0].n)).toBe(1);
    await rejected(owner.query("INSERT INTO policy_proposals(key,value,proposed_by) VALUES('hold_days','1','policy_alice')"), "23505", "P0403");
  });
  it("concurrent approvals of one proposal: exactly one wins", async () => {
    const id = (await asLogin("policy_alice", (c) => c.query("SELECT propose_policy('hold_days','7') id"))).rows[0].id;
    const res = await Promise.allSettled(["policy_bob", "policy_carol", "policy_bob", "policy_carol"].map((u) => asLogin(u, (c) => c.query("SELECT approve_policy_proposal($1)", [id]))));
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await owner.query("SELECT version FROM accounting_policy WHERE key='hold_days'")).rows[0].version).toBe(1);
  });
});

describe("F. each policy is validated against explicit rules", () => {
  it("rejects unknown keys and out-of-range or non-enumerated values", async () => {
    const bad: Array<[string, string]> = [["rogue_key", "1"], ["hold_days", "-1"], ["hold_days", "366"], ["hold_days", "abc"], ["hold_days", "1.5"], ["coin_value_usd_micros", "0"], ["coin_value_usd_micros", "1000001"],
      ["min_payout_coins", "0"], ["review_threshold_coins", "0"], ["clawback_mode", "forgive"], ["clawback_mode", "DEBT"], ["remainder_rule", "anyone"], ["negative_balance_policy", "ignore"],
      ["chargeback_policy", "none"], ["family_reversal_policy", "x"], ["refund_policy", "x"]];
    for (const [k, v] of bad) await rejected(asLogin("policy_alice", (c) => c.query("SELECT propose_policy($1,$2)", [k, v])), "P0442", "P0001");
    expect(Number((await owner.query("SELECT count(*) n FROM policy_proposals")).rows[0].n)).toBe(0);
  });
  it("accepts the documented enumerations and enforces min_payout <= review_threshold at approval", async () => {
    await approvePolicies({ clawback_mode: "manual_review", remainder_rule: "creator", negative_balance_policy: "block", chargeback_policy: "hold_only", family_reversal_policy: "creator_absorbs", refund_policy: "admin_review" });
    await approvePolicies({ min_payout_coins: "100", review_threshold_coins: "1000" });
    const id = (await asLogin("policy_alice", (c) => c.query("SELECT propose_policy('min_payout_coins','5000') id"))).rows[0].id;
    await rejected(asLogin("policy_bob", (c) => c.query("SELECT approve_policy_proposal($1)", [id])), "P0442");
  });
  it("a direct proposal row with an invalid value is refused by the table constraint, and decisions need decided_by", async () => {
    await owner.query("GRANT INSERT ON policy_proposals TO policy_alice; GRANT USAGE ON SEQUENCE policy_proposals_id_seq TO policy_alice");
    try {
      await rejected(asLogin("policy_alice", (c) => c.query("INSERT INTO policy_proposals(key,value,proposed_by) VALUES('clawback_mode','forgive','policy_alice')")), "23514", "P0442", "P0403");
      await rejected(asLogin("policy_alice", (c) => c.query("INSERT INTO policy_proposals(key,value,proposed_by,status,decided_at) VALUES('hold_days','1','policy_alice','approved',now())")), "23514", "P0403");
    } finally { await owner.query("REVOKE INSERT ON policy_proposals FROM policy_alice; REVOKE USAGE ON SEQUENCE policy_proposals_id_seq FROM policy_alice"); }
  });
});

describe("G. chargeback holds require a recorded, verified-event reference and are bounded", () => {
  beforeEach(async () => { await approvePolicies(POLICY); await verify("c1"); });
  it("forged, unknown, wrong-kind and unmatched events place nothing", async () => {
    await earn("c1", 1000n, "a");
    await rejected(app.query("SELECT place_chargeback_holds(424242)"), "P0441");
    const wrongKind = await chargebackEvent("p-a", "refund");
    await rejected(app.query("SELECT place_chargeback_holds($1)", [wrongKind]), "P0441");
    const noPurchase = await chargebackEvent("never-bought");
    await rejected(app.query("SELECT place_chargeback_holds($1)", [noPurchase]), "P0441");
    expect(Number((await owner.query("SELECT count(*) n FROM payout_holds")).rows[0].n)).toBe(0);
  });
  it("only the system function can create chargeback holds or cases; app and privileged owner inserts are refused", async () => {
    await earn("c1", 1000n, "a");
    await app.query("SELECT place_chargeback_holds($1)", [await chargebackEvent("p-a")]);
    await rejected(app.query("INSERT INTO payout_holds(user_id,kind,amount,reason,created_by,account_id) VALUES('c1','chargeback',100,'forged','x','earnings:c1')"), "42501", "P0443");
    await rejected(app.query("INSERT INTO chargeback_cases(event_id,purchase_entry,user_id,coins,wallet_balance,unrecovered,lookback_days,hold_count,holds_total) VALUES(1,1,'x',1,1,1,1,0,0)"), "42501");
    await asOwner(["payout_holds", "chargeback_cases"], async (c) => {
      await rejected(c.query("INSERT INTO payout_holds(user_id,kind,amount,reason,created_by,account_id) VALUES('c1','chargeback',100,'forged','x','earnings:c1')"), "P0443");
      await rejected(c.query("INSERT INTO payout_holds(user_id,kind,amount,reason,created_by,account_id) VALUES('c1','refund',100,'forged','x','earnings:c1')"), "P0443");
      await rejected(c.query("UPDATE chargeback_cases SET holds_total=0"), "P0001", "P0403", "P0420", "55000");
    });
  });
  it("replayed events and a second event for the same purchase are no-ops", async () => {
    await earn("c1", 1000n, "a");
    const e1 = await chargebackEvent("p-a");
    expect(Number((await app.query("SELECT place_chargeback_holds($1) n", [e1])).rows[0].n)).toBeGreaterThan(0);
    const before = (await owner.query("SELECT sum(amount)::text s, count(*)::int n FROM payout_holds")).rows[0];
    expect(Number((await app.query("SELECT place_chargeback_holds($1) n", [e1])).rows[0].n)).toBe(0);
    expect(Number((await app.query("SELECT place_chargeback_holds($1) n", [await chargebackEvent("p-a")])).rows[0].n)).toBe(0);
    expect((await owner.query("SELECT sum(amount)::text s, count(*)::int n FROM payout_holds")).rows[0]).toEqual(before);
  });
  it("lookback is bounded to 1..180 days", async () => {
    await earn("c1", 1000n, "a");
    const e = await chargebackEvent("p-a");
    for (const d of [0, -5, 181, 100000]) await rejected(app.query("SELECT place_chargeback_holds($1,$2)", [e, d]), "P0440");
  });
  it("overlapping chargebacks cannot hold more than the eligible earnings or the unrecovered exposure", async () => {
    // One fan buys twice and spends it all on one creator; both purchases are charged back.
    await L.creditPurchase(app, { userId: "fan", coins: 600n, provider: "stripe", providerTxId: "pA" });
    await L.creditPurchase(app, { userId: "fan", coins: 400n, provider: "stripe", providerTxId: "pB" });
    await L.sendGift(app, { giftId: "gx", fromUser: "fan", creatorId: "c1", coins: 1000n, familyId: "f1", familyBps: 1000 });
    const eA = await chargebackEvent("pA"), eB = await chargebackEvent("pB");
    await Promise.allSettled([app.query("SELECT place_chargeback_holds($1)", [eA]), worker.query("SELECT place_chargeback_holds($1)", [eB])]);
    const held = (await owner.query("SELECT account_id, sum(amount)::bigint s FROM payout_holds WHERE kind='chargeback' AND status='active' GROUP BY 1")).rows;
    const bal = Object.fromEntries((await owner.query("SELECT id, balance FROM ledger_accounts WHERE id IN ('earnings:c1','family:f1')")).rows.map((r: any) => [r.id, BigInt(r.balance)]));
    for (const h of held) expect(BigInt(h.s)).toBeLessThanOrEqual(bal[h.account_id]);
    const total = held.reduce((a: bigint, h: any) => a + BigInt(h.s), 0n);
    expect(total).toBeLessThanOrEqual(1000n);
    const cases = (await owner.query("SELECT holds_total, unrecovered FROM chargeback_cases")).rows;
    for (const c of cases) expect(BigInt(c.holds_total)).toBeLessThanOrEqual(BigInt(c.unrecovered));
    expect(await sumAll()).toBe("0");
  });
  it("hold release and consumption need audit evidence; identity and amount are immutable", async () => {
    await earn("c1", 1000n, "a");
    await app.query("SELECT place_chargeback_holds($1)", [await chargebackEvent("p-a")]);
    const h = (await owner.query("SELECT id FROM payout_holds WHERE kind='chargeback' LIMIT 1")).rows[0].id;
    await rejected(owner.query("UPDATE payout_holds SET amount=1 WHERE id=$1", [h]), "P0443");
    await rejected(owner.query("UPDATE payout_holds SET status='released' WHERE id=$1", [h]), "P0443");
    await rejected(owner.query("UPDATE payout_holds SET status='consumed' WHERE id=$1", [h]), "P0443");
    await owner.query("UPDATE payout_holds SET status='released', released_by='admin1', released_at=now() WHERE id=$1", [h]);
    await rejected(owner.query("UPDATE payout_holds SET status='active' WHERE id=$1", [h]), "P0443");
  });
});

describe("H. payout journal entries are bound to their payout id", () => {
  async function onePayout() {
    await approvePolicies(POLICY); await verify("c1"); await earn("c1", 1000n, "a");
    const r = await P.requestPayout(worker, sim, { userId: "c1", key: "k1", coins: 100n, actor: "c1" });
    return Number(r.payout.id);
  }
  it("entries touching payout accounts without a payout, with a wrong payoutId, or with a mismatched key are refused", async () => {
    const id = await onePayout();
    await L.ensureAccount(app, "payout:clearing", "payout_clearing");
    const mk = (key: string, metadata?: object) => L.postEntry(app, { key, type: "payout_settle", metadata, postings: [{ account: "payout:clearing", amount: -10n }, { account: "payout:paid", amount: 10n }] });
    await L.ensureAccount(app, "payout:paid", "payout_paid").catch(() => undefined);
    await rejected(mk("orphan-1"), "P0431");
    await rejected(mk(`payout:${id}:settle`, { payoutId: id + 1 }), "P0431", "P0430");
    await rejected(mk(`payout:${id + 1}:settle`, { payoutId: id + 1 }), "P0431", "P0430");
    await rejected(mk("payout-key-mismatch", { payoutId: id }), "P0431", "P0430");
    expect(await sumAll()).toBe("0");
  });
  it("a payout row pointing at another payout's ledger entry cannot be committed (privileged owner attack)", async () => {
    const id1 = await onePayout();
    await earn("c1", 1000n, "b");
    const id2 = Number((await P.requestPayout(worker, sim, { userId: "c1", key: "k2", coins: 100n, actor: "c1" })).payout.id);
    const e1 = (await owner.query("SELECT reserve_entry FROM payouts WHERE id=$1", [id1])).rows[0].reserve_entry;
    const e2 = (await owner.query("SELECT reserve_entry FROM payouts WHERE id=$1", [id2])).rows[0].reserve_entry;
    expect(e1).not.toBe(e2);
    await asOwner(["payouts"], async (c) => {
      await rejected(c.query("UPDATE payouts SET reserve_entry=$1 WHERE id=$2", [e1, id2]), "P0001", "P0403", "P0430", "23505", "55000");
      await rejected(c.query("UPDATE payouts SET reserve_entry=NULL WHERE id=$1", [id2]), "P0001", "P0403", "P0430", "55000");
    });
    expect(await sumAll()).toBe("0");
  });
});

describe("I. DDL / TRUNCATE / trigger guards do not depend on settable flags", () => {
  it("privileged non-superuser (even as owner, even with xtc.* flags set) cannot truncate, disable triggers, or alter functions", async () => {
    await approvePolicies(POLICY);
    const tables = ["postings", "journal_entries", "payouts", "payout_provider_evidence", "accounting_policy", "chargeback_cases"];
    const all = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map((r: any) => r.tablename as string);
    await asOwner(all, async (c) => {
      const cl = await c.pool.connect();
      try {
        await cl.query("SET xtc.migrating='on'; SET xtc.allow_destructive='on'; SET xtc.policy_fn='on'");
        for (const t of tables) {
          await rejected(cl.query(`TRUNCATE ${t} CASCADE`).then(() => undefined), "P0450", "0A000");
          await rejected(cl.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`), "P0451", "42501");
        }
        await rejected(cl.query("ALTER TABLE payouts DISABLE TRIGGER payouts_guard_trg"), "P0451", "42501");
        await rejected(cl.query("DROP TRIGGER no_truncate ON payouts"), "P0451", "42501");
        await rejected(cl.query("SET session_replication_role = replica"), "42501");
        await rejected(cl.query("DROP EVENT TRIGGER ddl_guard_evt"), "42501", "42704");
        await rejected(cl.query("ALTER TABLE payouts DROP CONSTRAINT payouts_pkey CASCADE"), "P0451", "42501");
      } finally { cl.release(); }
    });
    await rejected(dba.query("CREATE OR REPLACE FUNCTION is_runtime_identity() RETURNS boolean LANGUAGE sql AS 'SELECT false'"), "P0451", "42501", "42P13");
    await rejected(dba.query("GRANT INSERT ON payout_provider_evidence TO xtc_app"), "P0451", "42501");
    await rejected(app.query("TRUNCATE postings"), "42501");
    await rejected(app.query("CREATE TABLE x(a int)"), "42501", "P0451");
  });
  it("the migrator identity (separately controlled) is the only non-superuser path for sanctioned schema changes", async () => {
    expect((await owner.query("SELECT is_direct_member('xtc_migrator') m")).rows[0].m).toBe(true);
    for (const u of ["t_app", "t_worker", "t_admin", "dba_np", "policy_alice"]) {
      const r = await asLogin(u, (c) => c.query("SELECT is_direct_member('xtc_migrator') m"));
      expect(r.rows[0].m, u).toBe(false);
    }
  });
  it("runtime logins have no DDL, no superuser, no role-creation and no BYPASSRLS", async () => {
    const r = (await owner.query("SELECT rolname, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = ANY(ARRAY['t_app','t_worker','xtc_app','xtc_provider_worker','xtc_policy_admin'])")).rows;
    for (const x of r) { expect(x.rolsuper, x.rolname).toBe(false); expect(x.rolcreaterole, x.rolname).toBe(false); expect(x.rolbypassrls, x.rolname).toBe(false); }
  });
});
