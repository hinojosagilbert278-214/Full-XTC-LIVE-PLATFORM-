export interface Queryable {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}
export interface Posting { account: string; amount: bigint; role?: string }

export class InsufficientFundsError extends Error {}
export class InvalidSplitError extends Error {}

export const PLATFORM = "platform:revenue";
export const ISSUANCE = "platform:issuance";
export const walletId = (u: string) => `wallet:${u}`;
export const earningsId = (u: string) => `earnings:${u}`;
export const familyId = (f: string) => `family:${f}`;

const CREATOR_PCT = 70n;
export const MAX_FAMILY_BPS = 1000; // 10% of the creator's share

/**
 * Split a gift. Platform keeps 30% plus any rounding remainder; family gets
 * floor(creatorShare * bps / 10000) of the creator's share. All integer math.
 */
export function splitGift(coins: bigint, familyBps: number) {
  if (coins <= 0n) throw new InvalidSplitError("coins must be positive");
  if (!Number.isInteger(familyBps) || familyBps < 0 || familyBps > MAX_FAMILY_BPS)
    throw new InvalidSplitError("family share must be 0..1000 bps");
  const creatorShare = (coins * CREATOR_PCT) / 100n;
  const family = (creatorShare * BigInt(familyBps)) / 10000n;
  return { creator: creatorShare - family, family, platform: coins - creatorShare };
}

export async function ensureAccount(db: Queryable, id: string, kind: string, ownerId?: string, allowNegative = false) {
  await db.query(
    `INSERT INTO ledger_accounts(id,kind,owner_id,allow_negative) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [id, kind, ownerId ?? null, allowNegative],
  );
}

type Tx = Queryable;
export type TxRunner = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

/**
 * Post a balanced journal entry atomically and idempotently.
 * Returns {entryId, replayed}. A replay with the same key but different postings is rejected.
 */
export async function postEntry(
  db: TxRunner,
  p: { key: string; type: string; postings: Posting[]; metadata?: object; reverses?: number },
): Promise<{ entryId: number; replayed: boolean }> {
  if (p.postings.reduce((s, x) => s + x.amount, 0n) !== 0n) throw new Error("entry does not balance");
  const sig = JSON.stringify(p.postings.map((x) => [x.account, x.amount.toString()]));
  try {
    return await db.transaction(async (tx) => {
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO journal_entries(idempotency_key,type,reverses_entry,metadata)
         VALUES($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [p.key, p.type, p.reverses ?? null, JSON.stringify({ ...p.metadata, sig })],
      );
      if (ins.rows.length === 0) {
        const ex = await tx.query<{ id: number; metadata: { sig: string } }>(
          `SELECT id, metadata FROM journal_entries WHERE idempotency_key=$1`, [p.key]);
        if (ex.rows[0].metadata.sig !== sig) throw new Error("idempotency key reused with different payload");
        return { entryId: Number(ex.rows[0].id), replayed: true };
      }
      const entryId = Number(ins.rows[0].id);
      // Deterministic account order avoids deadlocks under concurrent writers.
      for (const x of [...p.postings].sort((a, b) => a.account.localeCompare(b.account)))
        await tx.query(`INSERT INTO postings(entry_id,account_id,amount,role) VALUES($1,$2,$3,$4)`,
          [entryId, x.account, x.amount, x.role ?? "primary"]);
      return { entryId, replayed: false };
    });
  } catch (e) {
    if (/no_negative_balance/.test(String((e as Error).message))) throw new InsufficientFundsError("insufficient funds");
    throw e;
  }
}

/** Credit coins after a verified store/web purchase (webhook-safe: key = provider transaction id). */
export async function creditPurchase(db: TxRunner & Queryable, o: { provider: string; providerTxId: string; userId: string; coins: bigint }) {
  await ensureAccount(db, ISSUANCE, "coin_issuance", undefined, true);
  await ensureAccount(db, walletId(o.userId), "user_wallet", o.userId);
  return postEntry(db, {
    key: `purchase:${o.provider}:${o.providerTxId}`, type: "purchase", metadata: { provider: o.provider },
    postings: [{ account: ISSUANCE, amount: -o.coins }, { account: walletId(o.userId), amount: o.coins }],
  });
}

/** Send a gift: viewer wallet -> creator earnings, family earnings (separate posting), platform. */
export async function sendGift(db: TxRunner & Queryable, o: { giftId: string; fromUser: string; creatorId: string; coins: bigint; familyId?: string; familyBps?: number }) {
  const s = splitGift(o.coins, o.familyId ? (o.familyBps ?? 0) : 0);
  await ensureAccount(db, PLATFORM, "platform_revenue");
  await ensureAccount(db, walletId(o.fromUser), "user_wallet", o.fromUser);
  await ensureAccount(db, earningsId(o.creatorId), "creator_earnings", o.creatorId);
  const postings: Posting[] = [
    { account: walletId(o.fromUser), amount: -o.coins, role: "gift_debit" },
    { account: earningsId(o.creatorId), amount: s.creator, role: "creator_share" },
    { account: PLATFORM, amount: s.platform, role: "platform_share" },
  ];
  if (s.family > 0n) {
    await ensureAccount(db, familyId(o.familyId!), "family_earnings", o.familyId);
    postings.push({ account: familyId(o.familyId!), amount: s.family, role: "family_share" });
  }
  return postEntry(db, { key: `gift:${o.giftId}`, type: "gift", postings: postings.filter((p) => p.amount !== 0n), metadata: { ...s, creator: s.creator.toString(), family: s.family.toString(), platform: s.platform.toString() } });
}

/** Reverse an entry exactly (refund/chargeback). Fails with InsufficientFundsError if funds were already spent/paid out. */
export async function reverseEntry(db: TxRunner & Queryable, o: { entryId: number; key: string; reason: string }) {
  const r = await db.query<{ account_id: string; amount: string; role: string }>(
    `SELECT account_id, amount, role FROM postings WHERE entry_id=$1`, [o.entryId]);
  if (r.rows.length === 0) throw new Error("entry not found");
  return postEntry(db, {
    key: o.key, type: "reversal", reverses: o.entryId, metadata: { reason: o.reason },
    postings: r.rows.map((x) => ({ account: x.account_id, amount: -BigInt(x.amount), role: `reversal:${x.role}` })),
  });
}

export async function balanceOf(db: Queryable, id: string): Promise<bigint> {
  const r = await db.query<{ balance: string }>(`SELECT balance FROM ledger_accounts WHERE id=$1`, [id]);
  return BigInt(r.rows[0]?.balance ?? 0);
}

/** Invariants: global sum is zero and cached balances match postings. */
export async function checkInvariants(db: Queryable) {
  const total = await db.query<{ s: string }>(`SELECT COALESCE(SUM(amount),0) AS s FROM postings`);
  const bad = await db.query(`SELECT * FROM ledger_discrepancies`);
  return { globalSum: BigInt(total.rows[0].s), discrepancies: bad.rows };
}
