import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startApp, call, token } from "./apihelper";
import * as L from "../../src/ledger/ledger";

let s: Awaited<ReturnType<typeof startApp>>;
const alice = token("alice"), bob = token("bob"), admin = token("root", "admin"), svc = token("billing", "service");

beforeAll(async () => {
  s = await startApp();
  await s.db.query(`INSERT INTO products(sku,coins) VALUES('coins_500',500),('coins_100',100)`);
  await s.db.query(`INSERT INTO families(id,share_bps) VALUES('fam1',1000)`);
  await s.db.query(`INSERT INTO family_memberships(user_id,family_id,role) VALUES('carol','fam1','member'),('lead','fam1','leader'),('mia','fam1','member')`);
  await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { provider: "manual", providerTxId: "seed1", userId: "alice", sku: "coins_500" } });
});
afterAll(async () => { await s.close(); });

describe("authentication", () => {
  it("rejects missing, forged, expired, wrong-audience and alg=none tokens", async () => {
    const none = Buffer.from('{"alg":"none"}').toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: "alice", exp: 9999999999, iss: "xtc-identity", aud: "xtc-wallet" })).toString("base64url") + ".";
    const cases = [undefined, "garbage", alice.slice(0, -3) + "AAA", token("alice", "user", { exp: 1 }), token("alice", "user", { aud: "other" }), token("alice", "user", { iss: "evil" }), none];
    for (const t of cases) expect((await call(s.url, "GET", "/v1/wallet", { tok: t })).status).toBe(401);
  });
  it("blocks non-admin from admin routes and users from crediting coins", async () => {
    expect((await call(s.url, "GET", "/v1/admin/reconciliation", { tok: alice })).status).toBe(403);
    expect((await call(s.url, "POST", "/v1/admin/purchases", { tok: alice, body: { provider: "manual", providerTxId: "x", userId: "alice", sku: "coins_500" } })).status).toBe(403);
    expect((await call(s.url, "GET", "/v1/admin/reconciliation", { tok: svc })).status).toBe(403);
  });
  it("records failures in an immutable audit log", async () => {
    const r = await s.db.query(`SELECT action FROM audit_log WHERE action IN ('auth.failed','authz.denied')`);
    expect(r.rows.length).toBeGreaterThan(5);
    await expect(s.db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe("wallet reads and resource authorization", () => {
  it("returns own balance and history only", async () => {
    expect((await call(s.url, "GET", "/v1/wallet", { tok: alice })).body.balance).toBe("500");
    expect((await call(s.url, "GET", "/v1/wallet", { tok: bob })).body.balance).toBe("0");
    const h = await call(s.url, "GET", "/v1/wallet/transactions?limit=10", { tok: alice });
    expect(h.body.items[0]).toMatchObject({ type: "purchase", amount: "500" });
    expect((await call(s.url, "GET", "/v1/wallet/transactions", { tok: bob })).body.items).toEqual([]);
  });
  it("hides other users' transactions (404) and validates ids", async () => {
    const id = (await call(s.url, "GET", "/v1/wallet/transactions", { tok: alice })).body.items[0].entryId;
    expect((await call(s.url, "GET", `/v1/transactions/${id}`, { tok: alice })).body.status).toBe("completed");
    expect((await call(s.url, "GET", `/v1/transactions/${id}`, { tok: bob })).status).toBe(404);
    expect((await call(s.url, "GET", `/v1/transactions/abc`, { tok: alice })).status).toBe(404);
  });
});

describe("gifts", () => {
  it("requires an Idempotency-Key and strict validated body", async () => {
    expect((await call(s.url, "POST", "/v1/gifts", { tok: alice, body: { creatorId: "bob", coins: 10 } })).status).toBe(400);
    for (const body of [{ creatorId: "bob", coins: -5 }, { creatorId: "bob", coins: 1.5 }, { creatorId: "bob", coins: "10" }, { creatorId: "b:ob", coins: 10 }, { creatorId: "bob", coins: 10, familyBps: 0 }, { creatorId: "bob", coins: 10, from: "bob" }, { creatorId: "alice", coins: 10 }])
      expect((await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "k-bad", body })).status).toBe(422);
    expect((await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "k-bad", raw: "{nope" })).status).toBe(400);
    expect((await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "k-bad", raw: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "k-bad", raw: JSON.stringify({ x: "a".repeat(40000) }) })).status).toBe(413);
  });

  it("applies the server-determined 70/30 and family split and is idempotent", async () => {
    const q = await call(s.url, "GET", "/v1/gifts/quote?coins=100&creatorId=carol", { tok: alice });
    expect(q.body).toMatchObject({ familyId: "fam1", familyBps: 1000, split: { creator: "63", family: "7", platform: "30" } });
    const a = await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "g1", body: { creatorId: "carol", coins: 100 } });
    expect(a.status).toBe(201);
    const b = await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "g1", body: { creatorId: "carol", coins: 100 } });
    expect(b.status).toBe(200); expect(b.body.entryId).toBe(a.body.entryId); expect(b.body.replayed).toBe(true);
    expect((await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "g1", body: { creatorId: "carol", coins: 101 } })).status).toBe(409);
    expect((await call(s.url, "GET", "/v1/wallet", { tok: alice })).body.balance).toBe("400");
    const e = await call(s.url, "GET", "/v1/creators/me/earnings", { tok: token("carol") });
    expect(e.body.balance).toBe("63");
    expect(await L.balanceOf(s.db, L.familyId("fam1"))).toBe(7n);
  });

  it("key scoping: the same Idempotency-Key from two users does not collide", async () => {
    await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { provider: "manual", providerTxId: "seed2", userId: "bob", sku: "coins_100" } });
    const r1 = await call(s.url, "POST", "/v1/gifts", { tok: bob, key: "g1", body: { creatorId: "carol", coins: 10 } });
    expect(r1.status).toBe(201);
  });

  it("20 simultaneous HTTP gifts of 100 from a 300-coin wallet: only 3 succeed", async () => {
    await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { provider: "manual", providerTxId: "seed3", userId: "dave", sku: "coins_100" } });
    await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { provider: "manual", providerTxId: "seed4", userId: "dave", sku: "coins_100" } });
    await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { provider: "manual", providerTxId: "seed5", userId: "dave", sku: "coins_100" } });
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call(s.url, "POST", "/v1/gifts", { tok: token("dave"), key: `d${i}`, body: { creatorId: "mia", coins: 100 } })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 409 && r.body.error === "insufficient_funds")).toHaveLength(17);
    expect((await call(s.url, "GET", "/v1/wallet", { tok: token("dave") })).body.balance).toBe("0");
  });
});

describe("purchase crediting", () => {
  it("credits from the catalog only, idempotently, and rejects unknown SKUs and client coin amounts", async () => {
    const body = { provider: "stripe", providerTxId: "pi_1", userId: "erin", sku: "coins_500" };
    expect((await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body })).status).toBe(201);
    expect((await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body })).body.replayed).toBe(true);
    expect((await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { ...body, providerTxId: "pi_2", sku: "free_money" } })).status).toBe(422);
    expect((await call(s.url, "POST", "/v1/admin/purchases", { tok: svc, body: { ...body, providerTxId: "pi_3", coins: 999999 } })).status).toBe(422);
    expect((await call(s.url, "GET", "/v1/wallet", { tok: token("erin") })).body.balance).toBe("500");
  });
});

describe("refunds", () => {
  it("only the payer can request; admin approval reverses once; replays are safe", async () => {
    const g = await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "gr", body: { creatorId: "carol", coins: 50 } });
    const entryId = g.body.entryId;
    expect((await call(s.url, "POST", "/v1/refunds", { tok: bob, key: "r1", body: { entryId, reason: "not mine" } })).status).toBe(404);
    const rq = await call(s.url, "POST", "/v1/refunds", { tok: alice, key: "r1", body: { entryId, reason: "mistake" } });
    expect(rq.status).toBe(202);
    expect((await call(s.url, "POST", "/v1/refunds", { tok: alice, key: "r1", body: { entryId, reason: "mistake" } })).status).toBe(200);
    expect((await call(s.url, "POST", "/v1/refunds", { tok: alice, key: "r2", body: { entryId, reason: "again" } })).status).toBe(409);
    const before = (await call(s.url, "GET", "/v1/wallet", { tok: alice })).body.balance;
    expect((await call(s.url, "POST", `/v1/admin/refunds/${rq.body.refundId}/decision`, { tok: alice, body: { approve: true } })).status).toBe(403);
    const results = await Promise.all([1, 2, 3].map(() => call(s.url, "POST", `/v1/admin/refunds/${rq.body.refundId}/decision`, { tok: admin, body: { approve: true } })));
    // Approvals are idempotent: every caller sees the same single reversal entry.
    expect(results.every((r) => r.status === 200 && r.body.reversalEntry === results[0].body.reversalEntry)).toBe(true);
    expect((await call(s.url, "GET", "/v1/wallet", { tok: alice })).body.balance).toBe(String(BigInt(before) + 50n));
    expect((await call(s.url, "GET", `/v1/transactions/${entryId}`, { tok: alice })).body.status).toBe("reversed");
    expect((await call(s.url, "GET", `/v1/refunds/${rq.body.refundId}`, { tok: alice })).body.status).toBe("completed");
  });

  it("parks refunds in needs_review when funds were already spent (never goes negative)", async () => {
    const g = await call(s.url, "POST", "/v1/gifts", { tok: alice, key: "gs", body: { creatorId: "lead", coins: 10 } });
    const rq = await call(s.url, "POST", "/v1/refunds", { tok: alice, key: "rs", body: { entryId: g.body.entryId, reason: "spent case" } });
    await s.db.query(`UPDATE ledger_accounts SET balance=0 WHERE id='earnings:lead'`); // creator already paid out
    const d = await call(s.url, "POST", `/v1/admin/refunds/${rq.body.refundId}/decision`, { tok: admin, body: { approve: true } });
    expect(d.status).toBe(409); expect(d.body.error).toBe("needs_manual_review");
    expect((await call(s.url, "GET", `/v1/refunds/${rq.body.refundId}`, { tok: alice })).body.status).toBe("needs_review");
    await s.db.query(`UPDATE ledger_accounts SET balance=7 WHERE id='earnings:lead'`); // restore for invariants
  });
});

describe("family authorization and reconciliation", () => {
  it("family earnings visible only to leaders/co-leaders/admin", async () => {
    expect((await call(s.url, "GET", "/v1/families/fam1/earnings", { tok: token("lead") })).status).toBe(200);
    expect((await call(s.url, "GET", "/v1/families/fam1/earnings", { tok: token("carol") })).status).toBe(404);
    expect((await call(s.url, "GET", "/v1/families/fam1/earnings", { tok: admin })).status).toBe(200);
  });
  it("reconciliation reports a balanced ledger", async () => {
    const r = await call(s.url, "GET", "/v1/admin/reconciliation", { tok: admin });
    expect(r.body).toMatchObject({ ok: true, globalSum: "0", discrepancies: [] });
  });
});

describe("rate limiting", () => {
  it("returns 429 after the limit", async () => {
    const lim = await startApp({ RATE_LIMIT_PER_MINUTE: "5" });
    const rs = [];
    for (let i = 0; i < 12; i++) rs.push((await call(lim.url, "GET", "/v1/wallet", { tok: token("x") })).status);
    expect(rs).toContain(429);
    await lim.close();
  });
});
