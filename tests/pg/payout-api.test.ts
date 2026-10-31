import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgDb } from "../../src/db/pg";
import { startApp, call, token } from "./apihelper";
import { payoutRoutes } from "../../src/payouts/routes";
import { SimulatedProvider } from "../../src/payouts/provider";
import { TEST_URL } from "./helper";
import * as L from "../../src/ledger/ledger";

let ctx: Awaited<ReturnType<typeof startApp>>, admin: PgDb; const sim = new SimulatedProvider();
beforeAll(async () => {
  admin = new PgDb(TEST_URL, 3, "xtc_admin");
  ctx = await startApp({}, [payoutRoutes(sim, admin)]);
  await L.creditPurchase(ctx.db, { userId: "fan", coins: 2000n, provider: "simulation", providerTxId: "p1" });
  await L.sendGift(ctx.db, { giftId: "g1", fromUser: "fan", creatorId: "c1", coins: 1000n });
});
afterAll(async () => { await ctx.close(); await admin.close(); });
const U = () => token("c1"), A = () => token("boss", "admin"), A2 = () => token("boss2", "admin");

describe("payout API", () => {
  it("requires authentication; admin routes require admin", async () => {
    expect((await call(ctx.url, "GET", "/v1/payouts")).status).toBe(401);
    expect((await call(ctx.url, "POST", "/v1/admin/payouts/1/review", { tok: U(), body: { decision: "approve" } })).status).toBe(403);
    expect((await call(ctx.url, "POST", "/v1/admin/policy/hold_days/proposals", { tok: U(), body: { value: "0" } })).status).toBe(403);
    expect((await call(ctx.url, "POST", "/v1/admin/holds", { tok: U(), body: { userId: "c1", kind: "admin", amount: 5, reason: "xxx" } })).status).toBe(403);
    expect((await call(ctx.url, "POST", "/v1/admin/accounts/c1/freeze", { tok: U(), body: { frozen: true } })).status).toBe(403);
  });
  it("is blocked (503) until an admin approves policy; approval goes through the xtc_admin role", async () => {
    await call(ctx.url, "PUT", "/v1/payouts/profile", { tok: U(), body: { providerAccountId: "acct_c1xyz" } });
    await ctx.db.query("UPDATE payout_profiles SET verification_status='verified', payouts_enabled=true"); // provider sync is covered elsewhere
    expect((await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: 100 }, key: "a" })).status).toBe(503);
    for (const [k, v] of Object.entries({ hold_days: "0", coin_value_usd_micros: "10000", min_payout_coins: "10", review_threshold_coins: "1000", clawback_mode: "debt" })) {
      const pr = await call(ctx.url, "POST", `/v1/admin/policy/${k}/proposals`, { tok: A(), body: { value: v } });
      expect(pr.status).toBe(201);
      const id = pr.body.proposalId;
      expect((await call(ctx.url, "POST", `/v1/admin/policy/proposals/${id}/approve`, { tok: A() })).status).toBe(403); // proposer cannot approve
      expect((await call(ctx.url, "POST", `/v1/admin/policy/proposals/${id}/approve`, { tok: A2() })).status).toBe(200);
      expect((await call(ctx.url, "POST", `/v1/admin/policy/proposals/${id}/approve`, { tok: A2() })).status).toBe(409);
    }
    expect((await call(ctx.url, "POST", "/v1/admin/policy/nope/proposals", { tok: A(), body: { value: "1" } })).status).toBe(404);
    expect((await call(ctx.url, "POST", "/v1/admin/policy/hold_days/proposals", { tok: A(), body: { value: "abc" } })).status).toBe(400);
    const h = (await ctx.db.query("SELECT proposed_by, actor, version FROM accounting_policy_history WHERE key='hold_days'")).rows[0];
    expect(h).toMatchObject({ proposed_by: "boss", actor: "boss2", version: 1 });
    const pol = (await call(ctx.url, "GET", "/v1/admin/policy", { tok: A() })).body;
    expect(pol.hold_days).toBe("0");
  });
  it("request is validated and idempotent; users see only their own payouts", async () => {
    expect((await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: 100 } })).status).toBe(400); // no Idempotency-Key
    expect((await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: -5 }, key: "bad" })).status).toBe(422);
    expect((await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: 100, userId: "other" }, key: "bad2" })).status).toBe(422);
    const r1 = await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: 100 }, key: "a" });
    const r2 = await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: 100 }, key: "a" });
    expect([r1.status, r2.status]).toEqual([202, 200]); expect(r2.body.id).toBe(r1.body.id);
    expect((await call(ctx.url, "POST", "/v1/payouts", { tok: U(), body: { coins: 999 }, key: "a" })).status).toBe(422);
    expect((await call(ctx.url, "GET", `/v1/payouts/${r1.body.id}`, { tok: token("mallory") })).status).toBe(404);
    expect((await call(ctx.url, "POST", `/v1/payouts/${r1.body.id}/cancel`, { tok: token("mallory") })).status).toBe(404);
    const mine = await call(ctx.url, "GET", `/v1/payouts/${r1.body.id}`, { tok: U() });
    expect(mine.body.status).toBe("pending_review"); expect(mine.body.history).toHaveLength(1);
  });
  it("admin review, holds and reconciliation work end to end; audit log records the actions", async () => {
    const id = (await call(ctx.url, "GET", "/v1/payouts", { tok: U() })).body.payouts[0].id;
    expect((await call(ctx.url, "POST", `/v1/admin/payouts/${id}/review`, { tok: A(), body: { decision: "approve" } })).body.status).toBe("queued");
    expect((await call(ctx.url, "POST", `/v1/admin/payouts/${id}/review`, { tok: A(), body: { decision: "approve" } })).status).toBe(409);
    const h = await call(ctx.url, "POST", "/v1/admin/holds", { tok: A(), body: { userId: "c1", kind: "risk", amount: 600, reason: "manual review" } });
    expect(h.status).toBe(201);
    expect((await call(ctx.url, "GET", "/v1/payouts/availability", { tok: U() })).body.available).toBe("0");
    expect((await call(ctx.url, "POST", `/v1/admin/holds/${h.body.id}/release`, { tok: A() })).status).toBe(200);
    expect((await call(ctx.url, "GET", "/v1/payouts/availability", { tok: U() })).body.available).toBe("600");
    expect((await call(ctx.url, "GET", "/v1/admin/payouts/reconciliation", { tok: A() })).body.ledger.ok).toBe(true);
    const acts = (await ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'payout.%' OR action LIKE 'hold.%' OR action LIKE 'policy.%'")).rows.map((r: any) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["payout.request", "payout.review.approve", "hold.create", "hold.release", "policy.approve"]));
  });
  it("wallet freeze is admin-only and blocks spending", async () => {
    expect((await call(ctx.url, "POST", "/v1/admin/accounts/fan/freeze", { tok: A(), body: { frozen: true } })).status).toBe(200);
    const r = await call(ctx.url, "POST", "/v1/gifts", { tok: token("fan"), body: { creatorId: "c1", coins: 50 }, key: "fz" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await call(ctx.url, "POST", "/v1/admin/accounts/fan/freeze", { tok: A(), body: { frozen: false } })).status).toBe(200);
  });
});
