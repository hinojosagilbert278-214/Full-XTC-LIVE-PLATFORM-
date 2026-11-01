import { z } from "zod";
import type { PgDb } from "../db/pg";
import type { App } from "../api/app";
import { HttpError } from "../api/app";
import * as L from "../ledger/ledger";
import type { PayoutProvider } from "./provider";
import * as P from "./service";

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const NUM = z.string().regex(/^[0-9]{1,18}$/);

/** adminDb connects as xtc_admin (holds, freezes). workerDb connects as a provider-worker login and is the only pool allowed to record provider evidence. */
export function payoutRoutes(provider: PayoutProvider, adminDb?: PgDb, workerDb?: PgDb) {
  return (app: App) => {
    const db = app.db;
    const me = (c: { principal: { sub: string } | null }) => c.principal!.sub;
    const map = async <T>(f: () => Promise<T>) => {
      try { return await f(); } catch (e) {
        if (e instanceof P.PolicyNotApprovedError) throw new HttpError(503, "policy_not_approved", e.message);
        if (e instanceof P.PayoutError) throw new HttpError(e.code === "not_found" ? 404 : 409, e.code);
        if (e instanceof L.IdempotencyConflictError) throw new HttpError(422, "idempotency_conflict");
        throw e;
      }
    };
    const view = (p: P.PayoutRow) => ({ id: p.id, status: p.status, coins: p.amount_coins, amountMinor: p.amount_minor, currency: p.currency, failureReason: p.failure_reason });

    app.route("GET", "/v1/payouts/availability", "user", async (c) => ({ body: await P.availability(db, me(c)) }));

    app.route("PUT", "/v1/payouts/profile", "user", async (c) => {
      const b = c.json(z.object({ providerAccountId: z.string().regex(/^acct_[A-Za-z0-9]{4,64}$/) }).strict());
      await P.linkAccount(db, me(c), b.providerAccountId);
      await app.audit({ actor: me(c), action: "payout.profile.link", outcome: "ok", ip: c.ip });
      return { body: { status: "unverified" } };
    });
    app.route("POST", "/v1/payouts/profile/sync", "user", async (c) => ({ body: await map(() => P.syncProfile(db, provider, me(c))) }));

    app.route("POST", "/v1/payouts", "user", async (c) => {
      const key = c.idempotencyKey();
      const b = c.json(z.object({ coins: z.number().int().positive().max(100_000_000) }).strict());
      const r = await map(() => P.requestPayout(db, provider, { userId: me(c), key, coins: BigInt(b.coins), actor: me(c) }));
      await app.audit({ actor: me(c), action: "payout.request", resource: `payout:${r.payout.id}`, outcome: r.replayed ? "replayed" : "ok", ip: c.ip, detail: { coins: b.coins } });
      return { status: r.replayed ? 200 : 202, body: { ...view(r.payout), replayed: r.replayed, note: "A payout is a request to transfer funds to your connected account; settlement timing depends on the provider and eligibility checks." } };
    });
    app.route("GET", "/v1/payouts", "user", async (c) => {
      const r = await db.query<P.PayoutRow>(`SELECT * FROM payouts WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [me(c)]);
      return { body: { payouts: r.rows.map(view) } };
    });
    app.route("GET", "/v1/payouts/:id", "user", async (c) => {
      const id = NUM.parse(c.params.id);
      const r = await db.query<P.PayoutRow>(`SELECT * FROM payouts WHERE id=$1 AND user_id=$2`, [id, me(c)]);
      if (!r.rows[0]) throw new HttpError(404, "not_found");
      const ev = await db.query(`SELECT from_status, to_status, at FROM payout_events WHERE payout_id=$1 ORDER BY id`, [id]);
      return { body: { ...view(r.rows[0]), history: ev.rows } };
    });
    app.route("POST", "/v1/payouts/:id/cancel", "user", async (c) => {
      const p = await map(() => P.cancelPayout(db, NUM.parse(c.params.id), me(c), { userId: me(c) }));
      await app.audit({ actor: me(c), action: "payout.cancel", resource: `payout:${p.id}`, outcome: "ok", ip: c.ip });
      return { body: view(p) };
    });

    const adminAudit = (c: any, action: string, resource: string, detail?: object) => app.audit({ actor: me(c), action, resource, outcome: "ok", ip: c.ip, detail });
    app.route("POST", "/v1/admin/payouts/:id/review", "admin", async (c) => {
      const b = c.json(z.object({ decision: z.enum(["approve", "reject"]) }).strict());
      const p = await map(() => P.reviewPayout(db, NUM.parse(c.params.id), b.decision, me(c)));
      await adminAudit(c, `payout.review.${b.decision}`, `payout:${p.id}`);
      return { body: view(p) };
    });
    app.route("POST", "/v1/admin/payouts/:id/resolve", "admin", async (c) => {
      const b = c.json(z.object({ action: z.enum(["retry", "fail", "mark_paid"]) }).strict());
      const p = await map(() => P.resolvePayout(workerDb ?? db, provider, NUM.parse(c.params.id), b.action, me(c)));
      await adminAudit(c, `payout.resolve.${b.action}`, `payout:${p.id}`);
      return { body: view(p) };
    });
    app.route("POST", "/v1/admin/payouts/:id/reverse", "admin", async (c) => {
      const b = c.json(z.object({ reason: z.string().min(3).max(200) }).strict());
      const p = await map(() => P.reversePayout(db, NUM.parse(c.params.id), b.reason, me(c)));
      await adminAudit(c, "payout.reverse", `payout:${p.id}`, { reason: b.reason });
      return { body: view(p) };
    });
    app.route("POST", "/v1/admin/holds", "admin", async (c) => {
      const b = c.json(z.object({ userId: ID, kind: z.enum(["admin", "risk", "chargeback"]), amount: z.number().int().positive(), reason: z.string().min(3).max(200) }).strict());
      const r = await (adminDb ?? db).query<{ id: string }>(`INSERT INTO payout_holds(user_id,kind,amount,reason,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`, [b.userId, b.kind, b.amount, b.reason, me(c)]);
      await adminAudit(c, "hold.create", `hold:${r.rows[0].id}`, b);
      return { status: 201, body: { id: r.rows[0].id } };
    });
    app.route("POST", "/v1/admin/holds/:id/release", "admin", async (c) => {
      const r = await (adminDb ?? db).query(`UPDATE payout_holds SET status='released', released_at=now(), released_by=$2 WHERE id=$1 AND status='active' RETURNING id`, [NUM.parse(c.params.id), me(c)]);
      if (!r.rows[0]) throw new HttpError(404, "not_found");
      await adminAudit(c, "hold.release", `hold:${c.params.id}`);
      return { body: { released: true } };
    });
    // Completes a needs_review refund by booking the unrecoverable shortfall as debt. Requires clawback_mode approved as 'debt'.
    app.route("POST", "/v1/admin/refunds/:id/clawback", "admin", async (c) => {
      const id = NUM.parse(c.params.id);
      const rr = await db.query<{ entry_id: string; status: string }>(`SELECT entry_id, status FROM refund_requests WHERE id=$1`, [id]);
      if (!rr.rows[0]) throw new HttpError(404, "not_found");
      if (!["needs_review", "pending"].includes(rr.rows[0].status)) throw new HttpError(409, "not_clawbackable");
      const r = await map(() => P.reverseWithClawback(db, { entryId: Number(rr.rows[0].entry_id), key: `refund:${id}:reversal`, reason: "refund_with_clawback" }));
      await db.query(`UPDATE refund_requests SET status='completed', decided_by=$2, decided_at=now(), reversal_entry=$3 WHERE id=$1`, [id, me(c), r.entryId]);
      await adminAudit(c, "refund.clawback", `refund:${id}`, { reversalEntry: r.entryId });
      return { body: { reversalEntry: r.entryId, replayed: r.replayed } };
    });
    app.route("POST", "/v1/admin/accounts/:user/freeze", "admin", async (c) => {
      const b = c.json(z.object({ frozen: z.boolean() }).strict());
      const u = ID.parse(c.params.user);
      const r = await (adminDb ?? db).query(`UPDATE ledger_accounts SET frozen=$2 WHERE id=$1 RETURNING id`, [L.walletId(u), b.frozen]);
      if (!r.rows[0]) throw new HttpError(404, "not_found");
      await adminAudit(c, b.frozen ? "wallet.freeze" : "wallet.unfreeze", `wallet:${u}`);
      return { body: { frozen: b.frozen } };
    });
    app.route("GET", "/v1/admin/payouts/reconciliation", "admin", async () => ({ body: await P.reconcilePayouts(db, provider) }));
    app.route("GET", "/v1/admin/policy", "admin", async () => ({ body: await P.getPolicy(db) }));
    // Policy proposals/approvals are deliberately NOT exposed over HTTP: each administrator uses their own database login
    // (`npm run policy`), so the database can authenticate two distinct people. See docs/OPERATIONS.md.
    app.route("GET", "/v1/admin/policy/proposals", "admin", async () => ({ body: (await db.query(`SELECT id,key,value,proposed_by,proposed_at,status,decided_by,decided_at FROM policy_proposals ORDER BY id DESC LIMIT 100`)).rows }));
  };
}
