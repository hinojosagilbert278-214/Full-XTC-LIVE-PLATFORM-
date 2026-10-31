import type { PgDb } from "../db/pg";
import * as L from "../ledger/ledger";
import { ProviderRejected, ProviderUnknown, type PayoutProvider } from "./provider";

export const CLEARING = "payout:clearing";
export const PAID = "payout:paid";
export const debtId = (u: string) => `debt:creator:${u}`;
const DEFAULT_MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 120;

export class PolicyNotApprovedError extends Error {}
export class PayoutError extends Error { constructor(public code: string, message?: string) { super(message ?? code); } }

export type PayoutStatus = "pending_review" | "queued" | "processing" | "paid" | "failed" | "reversed" | "cancelled" | "needs_review";
export interface PayoutRow {
  id: string; user_id: string; idempotency_key: string; amount_coins: string; amount_minor: string; currency: string;
  status: PayoutStatus; provider: string; provider_account_id: string; provider_ref: string | null; attempts: number; failure_reason: string | null;
}

export async function getPolicy(db: L.Queryable) {
  const r = await db.query<{ key: string; value: string | null }>(`SELECT key, value FROM accounting_policy`);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value])) as Record<string, string | null>;
}

const REQUIRED = ["hold_days", "coin_value_usd_micros", "min_payout_coins", "review_threshold_coins", "clawback_mode"] as const;
function requirePolicy(p: Record<string, string | null>) {
  const missing = REQUIRED.filter((k) => p[k] == null);
  if (missing.length) throw new PolicyNotApprovedError(`policy not approved: ${missing.join(",")}`);
  return { holdDays: Number(p.hold_days), rateMicros: BigInt(p.coin_value_usd_micros!), minCoins: BigInt(p.min_payout_coins!), reviewCoins: BigInt(p.review_threshold_coins!), maxAttempts: Number(p.max_payout_attempts ?? DEFAULT_MAX_ATTEMPTS) };
}

/** Earnings split into pending / held / debt / available / reserved, all derived from immutable postings and rows. */
export async function availability(db: L.Queryable, userId: string) {
  const policy = await getPolicy(db);
  const balance = await L.balanceOf(db, L.earningsId(userId));
  const debt = -(await L.balanceOf(db, debtId(userId)));
  const holds = BigInt((await db.query<{ s: string }>(`SELECT COALESCE(SUM(amount),0) s FROM payout_holds WHERE user_id=$1 AND status='active'`, [userId])).rows[0].s);
  const reserved = BigInt((await db.query<{ s: string }>(`SELECT COALESCE(SUM(amount_coins),0) s FROM payouts WHERE user_id=$1 AND status IN ('pending_review','queued','processing','needs_review')`, [userId])).rows[0].s);
  let pending = 0n;
  if (policy.hold_days != null) {
    const r = await db.query<{ s: string }>(
      `SELECT COALESCE(SUM(p.amount),0) s FROM postings p JOIN journal_entries e ON e.id=p.entry_id
        WHERE p.account_id=$1 AND p.role IN ('creator_share','reversal:creator_share') AND e.created_at > now() - ($2 || ' days')::interval`,
      [L.earningsId(userId), String(Number(policy.hold_days))]);
    pending = BigInt(r.rows[0].s); if (pending < 0n) pending = 0n;
    if (pending > balance) pending = balance;
  }
  let available = balance - pending - holds - debt; if (available < 0n) available = 0n;
  return { balance, pending, held: holds, debt, reserved, available, policyApproved: REQUIRED.every((k) => policy[k] != null) };
}

const lockUser = (tx: L.Queryable, u: string) => tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payout:${u}`]);

async function returnFunds(tx: L.Queryable, p: PayoutRow) {
  await L.postEntryIn(tx, { key: `payout:${p.id}:return`, type: "payout_return", metadata: { payoutId: p.id },
    postings: [{ account: CLEARING, amount: -BigInt(p.amount_coins), role: "payout_return" }, { account: L.earningsId(p.user_id), amount: BigInt(p.amount_coins), role: "payout_return" }] });
}

export async function requestPayout(db: PgDb, provider: PayoutProvider, o: { userId: string; key: string; coins: bigint; actor: string }) {
  return db.transaction(async (tx) => {
    await lockUser(tx, o.userId);
    const ex = await tx.query<PayoutRow>(`SELECT * FROM payouts WHERE user_id=$1 AND idempotency_key=$2`, [o.userId, o.key]);
    if (ex.rows[0]) {
      if (BigInt(ex.rows[0].amount_coins) !== o.coins) throw new L.IdempotencyConflictError("idempotency key reused with different amount");
      return { payout: ex.rows[0], replayed: true };
    }
    const policy = requirePolicy(await getPolicy(tx));
    if (o.coins < policy.minCoins) throw new PayoutError("below_minimum");
    const prof = (await tx.query<{ provider_account_id: string | null; verification_status: string; payouts_enabled: boolean }>(`SELECT * FROM payout_profiles WHERE user_id=$1`, [o.userId])).rows[0];
    if (!prof?.provider_account_id) throw new PayoutError("no_payout_account");
    if (prof.verification_status !== "verified" || !prof.payouts_enabled) throw new PayoutError("account_not_verified");

    await L.ensureAccount(tx, L.earningsId(o.userId), "creator_earnings", o.userId);
    await L.ensureAccount(tx, CLEARING, "payout_clearing");
    await L.ensureAccount(tx, PAID, "payouts_paid");
    await L.ensureAccount(tx, debtId(o.userId), "creator_debt", o.userId, true);

    // Offset outstanding clawback debt against matured earnings first (never silently erased: a ledger entry records it).
    const a = await availability(tx, o.userId);
    const matured = a.balance - a.pending - a.held;
    if (a.debt > 0n && matured > 0n) {
      const off = a.debt < matured ? a.debt : matured;
      await L.postEntryIn(tx, { key: `debt_offset:${o.userId}:${o.key}`, type: "debt_offset",
        postings: [{ account: L.earningsId(o.userId), amount: -off, role: "debt_offset" }, { account: debtId(o.userId), amount: off, role: "debt_offset" }] });
    }
    const after = await availability(tx, o.userId);
    if (o.coins > after.available) throw new PayoutError("insufficient_available", `available ${after.available}`);

    const minor = (o.coins * policy.rateMicros) / 10_000n;
    if (minor <= 0n) throw new PayoutError("amount_too_small");
    const first = (await tx.query(`SELECT 1 FROM payouts WHERE user_id=$1 AND status='paid' LIMIT 1`, [o.userId])).rows.length === 0;
    const status: PayoutStatus = first || o.coins >= policy.reviewCoins ? "pending_review" : "queued";
    const ins = await tx.query<PayoutRow>(
      `INSERT INTO payouts(user_id,idempotency_key,amount_coins,amount_minor,currency,rate_micros,status,provider,provider_account_id,last_actor)
       VALUES($1,$2,$3,$4,'usd',$5,$6,$7,$8,$9) RETURNING *`,
      [o.userId, o.key, o.coins.toString(), minor.toString(), policy.rateMicros.toString(), status, provider.name, prof.provider_account_id, o.actor]);
    const p = ins.rows[0];
    try {
      await L.postEntryIn(tx, { key: `payout:${p.id}:reserve`, type: "payout_reserve", metadata: { payoutId: p.id },
        postings: [{ account: L.earningsId(o.userId), amount: -o.coins, role: "payout_reserve" }, { account: CLEARING, amount: o.coins, role: "payout_reserve" }] });
    } catch (e) { if (e instanceof L.InsufficientFundsError) throw new PayoutError("insufficient_available"); throw e; }
    return { payout: p, replayed: false };
  });
}

async function transition(tx: L.Queryable, id: string | number, from: PayoutStatus[], to: PayoutStatus, actor: string, set: { provider_ref?: string; failure_reason?: string | null; next_attempt_at?: Date; lease_until?: Date | null } = {}) {
  const r = await tx.query<PayoutRow>(
    `UPDATE payouts SET status=$3, last_actor=$4, failure_reason=COALESCE($5, failure_reason), provider_ref=COALESCE($6, provider_ref),
            next_attempt_at=COALESCE($7, next_attempt_at), lease_until=$8
      WHERE id=$1 AND status = ANY($2::text[]) RETURNING *`,
    [id, from, to, actor, set.failure_reason ?? null, set.provider_ref ?? null, set.next_attempt_at ?? null, set.lease_until ?? null]);
  return r.rows[0] ?? null;
}

const settle = (tx: L.Queryable, p: PayoutRow) => L.postEntryIn(tx, { key: `payout:${p.id}:settle`, type: "payout_settle", metadata: { payoutId: p.id, providerRef: p.provider_ref },
  postings: [{ account: CLEARING, amount: -BigInt(p.amount_coins), role: "payout_settle" }, { account: PAID, amount: BigInt(p.amount_coins), role: "payout_settle" }] });

export async function markPaid(db: PgDb, id: string | number, ref: string, actor: string) {
  return db.transaction(async (tx) => {
    const p = await transition(tx, id, ["processing", "needs_review"], "paid", actor, { provider_ref: ref, lease_until: null });
    if (!p) return null; // already settled by another worker: idempotent no-op
    await settle(tx, p);
    return p;
  });
}
export async function markFailed(db: PgDb, id: string | number, reason: string, actor: string, from: PayoutStatus[] = ["processing", "needs_review"]) {
  return db.transaction(async (tx) => {
    const p = await transition(tx, id, from, "failed", actor, { failure_reason: reason, lease_until: null });
    if (!p) return null;
    await returnFunds(tx, p);
    return p;
  });
}
export async function cancelPayout(db: PgDb, id: string | number, actor: string, opts: { userId?: string } = {}) {
  return db.transaction(async (tx) => {
    if (opts.userId) {
      const own = await tx.query(`SELECT 1 FROM payouts WHERE id=$1 AND user_id=$2`, [id, opts.userId]);
      if (!own.rows[0]) throw new PayoutError("not_found");
    }
    const p = await transition(tx, id, ["pending_review", "queued", "needs_review"], "cancelled", actor, { failure_reason: "cancelled", lease_until: null });
    if (!p) throw new PayoutError("not_cancellable");
    await returnFunds(tx, p);
    return p;
  });
}
export async function reviewPayout(db: PgDb, id: string | number, decision: "approve" | "reject", actor: string) {
  return db.transaction(async (tx) => {
    if (decision === "approve") {
      const p = await transition(tx, id, ["pending_review"], "queued", actor);
      if (!p) throw new PayoutError("not_pending_review");
      return p;
    }
    const p = await transition(tx, id, ["pending_review"], "cancelled", actor, { failure_reason: "rejected_in_review" });
    if (!p) throw new PayoutError("not_pending_review");
    await returnFunds(tx, p);
    return p;
  });
}
/** Provider reversed a transfer after payment: funds go back to earnings via a new entry; history is never edited. */
export async function reversePayout(db: PgDb, id: string | number, reason: string, actor: string) {
  return db.transaction(async (tx) => {
    const p = await transition(tx, id, ["paid"], "reversed", actor, { failure_reason: reason });
    if (!p) throw new PayoutError("not_reversible");
    await L.postEntryIn(tx, { key: `payout:${p.id}:reverse`, type: "payout_reverse", metadata: { payoutId: p.id, reason },
      postings: [{ account: PAID, amount: -BigInt(p.amount_coins), role: "payout_reverse" }, { account: L.earningsId(p.user_id), amount: BigInt(p.amount_coins), role: "payout_reverse" }] });
    return p;
  });
}
/** Admin resolution of a needs_review payout. mark_paid requires the provider to confirm the transfer exists. */
export async function resolvePayout(db: PgDb, provider: PayoutProvider, id: string | number, action: "retry" | "fail" | "mark_paid", actor: string) {
  if (action === "retry") return db.transaction(async (tx) => {
    const p = await transition(tx, id, ["needs_review"], "queued", actor, { next_attempt_at: new Date(), lease_until: null });
    if (!p) throw new PayoutError("not_in_review"); return p; });
  if (action === "fail") {
    const found = await provider.findTransfer(Number(id)).catch(() => { throw new PayoutError("provider_unavailable"); });
    if (found) throw new PayoutError("provider_transfer_exists", "cannot fail: provider has a transfer; use mark_paid");
    const p = await markFailed(db, id, "failed_by_admin", actor, ["needs_review"]); if (!p) throw new PayoutError("not_in_review"); return p;
  }
  const found = await provider.findTransfer(Number(id)).catch(() => { throw new PayoutError("provider_unavailable"); });
  if (!found) throw new PayoutError("provider_transfer_missing");
  const p = await markPaid(db, id, found.ref, actor); if (!p) throw new PayoutError("not_in_review"); return p;
}

const backoff = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 3600);

/** Claim due work with SKIP LOCKED + lease. Expired 'processing' leases are re-claimed (worker died mid-payout). */
export async function claimDue(db: PgDb, limit: number) {
  return db.transaction(async (tx) => {
    const r = await tx.query<PayoutRow & { was_processing: boolean }>(
      `WITH c AS (SELECT id, status = 'processing' AS wp FROM payouts
                   WHERE (status='queued' AND next_attempt_at <= now()) OR (status='processing' AND lease_until < now())
                   ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE payouts p SET status='processing', attempts = p.attempts + 1, lease_until = now() + ($2 || ' seconds')::interval, last_actor='worker'
         FROM c WHERE p.id = c.id RETURNING p.*, c.wp AS was_processing`, [limit, String(LEASE_SECONDS)]);
    return r.rows;
  });
}

export async function processDuePayouts(db: PgDb, provider: PayoutProvider, limit = 10) {
  const maxAttempts = requirePolicy(await getPolicy(db)).maxAttempts;
  const claimed = await claimDue(db, limit);
  const out = { paid: 0, failed: 0, retried: 0, review: 0 };
  for (const p of claimed) {
    const toReview = (reason: string) => db.transaction((tx) => transition(tx, p.id, ["processing"], "needs_review", "worker", { failure_reason: reason, lease_until: null }));
    try {
      // Any attempt after the first may follow an uncertain outcome: look before creating.
      if (p.attempts > 1 || p.was_processing) {
        const f = await provider.findTransfer(Number(p.id));
        if (f) {
          if (f.reversed) { await toReview("provider_transfer_reversed"); out.review++; } else { await markPaid(db, p.id, f.ref, "worker"); out.paid++; }
          continue;
        }
      }
      const acct = await provider.getAccount(p.provider_account_id);
      if (!acct.exists || !acct.verified || !acct.payoutsEnabled) { await toReview("account_not_eligible"); out.review++; continue; }
      const t = await provider.createTransfer({ payoutId: Number(p.id), accountId: p.provider_account_id, amountMinor: BigInt(p.amount_minor), currency: p.currency, idempotencyKey: `payout-${p.id}` });
      await markPaid(db, p.id, t.ref, "worker"); out.paid++;
    } catch (e) {
      if (e instanceof ProviderRejected) { await markFailed(db, p.id, `provider_rejected: ${e.message}`, "worker", ["processing"]); out.failed++; }
      else if (p.attempts >= maxAttempts) { await toReview(`attempts_exhausted: ${(e as Error).message}`); out.review++; }
      else {
        // Outcome unknown or transient: stay claimed in 'processing'; the lease expiry triggers lookup-then-retry.
        await db.query(`UPDATE payouts SET lease_until = now() + ($2 || ' seconds')::interval, failure_reason=$3 WHERE id=$1 AND status='processing'`, [p.id, String(backoff(p.attempts)), String((e as Error).message).slice(0, 200)]);
        out.retried++;
      }
    }
  }
  return out;
}

export function startPayoutWorker(db: PgDb, provider: PayoutProvider, intervalMs = 5000) {
  let stopped = false;
  const t = setInterval(async () => { if (!stopped) await processDuePayouts(db, provider).catch(() => {}); }, intervalMs);
  return { stop() { stopped = true; clearInterval(t); } };
}

export async function syncProfile(db: PgDb, provider: PayoutProvider, userId: string) {
  const prof = (await db.query<{ provider_account_id: string | null }>(`SELECT provider_account_id FROM payout_profiles WHERE user_id=$1`, [userId])).rows[0];
  if (!prof?.provider_account_id) throw new PayoutError("no_payout_account");
  const a = await provider.getAccount(prof.provider_account_id);
  const status = !a.exists ? "unverified" : a.verified ? "verified" : "pending";
  await db.query(`UPDATE payout_profiles SET verification_status=$2, payouts_enabled=$3, updated_at=now() WHERE user_id=$1`, [userId, status, a.exists && a.payoutsEnabled]);
  return { status, payoutsEnabled: a.exists && a.payoutsEnabled };
}
export async function linkAccount(db: PgDb, userId: string, accountId: string) {
  // Changing the destination resets verification; it must be re-verified with the provider.
  await db.query(`INSERT INTO payout_profiles(user_id, provider_account_id) VALUES($1,$2)
                  ON CONFLICT (user_id) DO UPDATE SET provider_account_id=$2, verification_status='unverified', payouts_enabled=false, updated_at=now()`, [userId, accountId]);
}

/** Reconciles the ledger and local payout rows with the provider. Read-only. */
export async function reconcilePayouts(db: PgDb, provider: PayoutProvider) {
  const sums = await db.query<{ status: string; s: string }>(`SELECT status, COALESCE(SUM(amount_coins),0) s FROM payouts GROUP BY status`);
  const by = Object.fromEntries(sums.rows.map((r) => [r.status, BigInt(r.s)])) as Record<string, bigint>;
  const sum = (...k: string[]) => k.reduce((a, x) => a + (by[x] ?? 0n), 0n);
  const expectedClearing = sum("pending_review", "queued", "processing", "needs_review");
  const expectedPaid = sum("paid");
  const clearing = await L.balanceOf(db, CLEARING), paid = await L.balanceOf(db, PAID);
  const mismatches: Array<{ payoutId: string; issue: string }> = [];
  const rows = await db.query<PayoutRow>(`SELECT * FROM payouts WHERE status IN ('paid','processing','needs_review','reversed')`);
  for (const p of rows.rows) {
    let t; try { t = await provider.findTransfer(Number(p.id)); } catch { mismatches.push({ payoutId: p.id, issue: "provider_unreachable" }); continue; }
    if (p.status === "paid") {
      if (!t) mismatches.push({ payoutId: p.id, issue: "paid_locally_missing_at_provider" });
      else if (t.ref !== p.provider_ref) mismatches.push({ payoutId: p.id, issue: "provider_ref_mismatch" });
      else if (t.amountMinor !== BigInt(p.amount_minor)) mismatches.push({ payoutId: p.id, issue: "amount_mismatch" });
      else if (t.reversed) mismatches.push({ payoutId: p.id, issue: "reversed_at_provider_not_locally" });
    } else if (p.status === "reversed") {
      if (t && !t.reversed) mismatches.push({ payoutId: p.id, issue: "reversed_locally_active_at_provider" });
    } else if (t) mismatches.push({ payoutId: p.id, issue: "provider_transfer_exists_for_unsettled_payout" });
  }
  const inv = await L.checkInvariants(db);
  return {
    ledger: { clearing, expectedClearing, paid, expectedPaid, ok: clearing === expectedClearing && paid === expectedPaid && inv.globalSum === 0n && inv.discrepancies.length === 0 },
    mismatches, ok: mismatches.length === 0 && clearing === expectedClearing && paid === expectedPaid && inv.globalSum === 0n && inv.discrepancies.length === 0,
  };
}

/**
 * Refund/chargeback reversal that records any recipient shortfall as debt instead of failing (decisions D2/D3/D5/D6).
 * Only runs when clawback_mode is approved as 'debt'. The original entry is reversed in full; the shortfall that the
 * recipient can no longer cover is booked to debt:<kind>:<owner> (a platform receivable) in the same balanced entry.
 */
export async function reverseWithClawback(db: PgDb, o: { entryId: number; key: string; reason: string }) {
  const mode = (await getPolicy(db)).clawback_mode;
  if (mode !== "debt") throw new PolicyNotApprovedError("clawback_mode must be approved as 'debt'");
  return db.transaction(async (tx) => {
    // A replay must not recompute from current balances (they have moved since the first execution).
    const done = await tx.query<{ id: string }>(`SELECT id FROM journal_entries WHERE idempotency_key=$1`, [o.key]);
    if (done.rows[0]) return { entryId: Number(done.rows[0].id), replayed: true };
    const orig = await tx.query<{ account_id: string; amount: string; role: string; kind: string; owner_id: string | null }>(
      `SELECT p.account_id, p.amount, p.role, a.kind, a.owner_id FROM postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.entry_id=$1 ORDER BY p.account_id`, [o.entryId]);
    if (!orig.rows.length) throw new PayoutError("entry_not_found");
    const owners = [...new Set(orig.rows.filter((r) => r.kind === "creator_earnings" && r.owner_id).map((r) => r.owner_id!))].sort();
    for (const u of owners) await lockUser(tx, u);
    const postings: L.Posting[] = [];
    for (const r of orig.rows) {
      const amt = BigInt(r.amount);
      const rev = -amt;
      if (amt > 0n && (r.kind === "creator_earnings" || r.kind === "family_earnings")) {
        const bal = await L.balanceOf(tx, r.account_id);
        const short = amt > bal ? amt - (bal > 0n ? bal : 0n) : 0n;
        if (short > 0n) {
          const debtAcct = r.kind === "creator_earnings" ? debtId(r.owner_id!) : `debt:family:${r.owner_id ?? r.account_id.replace(/^family:/, "")}`;
          await L.ensureAccount(tx, debtAcct, r.kind === "creator_earnings" ? "creator_debt" : "family_debt", r.owner_id ?? undefined, true);
          postings.push({ account: r.account_id, amount: rev + short, role: `reversal:${r.role}` });
          postings.push({ account: debtAcct, amount: -short, role: "debt_recorded" });
          continue;
        }
      }
      postings.push({ account: r.account_id, amount: rev, role: `reversal:${r.role}` });
    }
    const merged = postings.filter((p) => p.amount !== 0n);
    return L.postEntryIn(tx, { key: o.key, type: "reversal", reverses: o.entryId, metadata: { reason: o.reason, clawback: true }, postings: merged });
  });
}
