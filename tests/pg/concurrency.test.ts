import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as L from "../../src/ledger/ledger";
import { PgDb, migrate } from "../../src/db/pg";
import { freshDb, sleep, deferred } from "./helper";

let db: PgDb;
beforeEach(async () => { await db?.close(); db = await freshDb(); });
afterAll(async () => { await db?.close(); });

const fund = (user: string, coins: bigint, tx = `fund-${user}`) =>
  L.creditPurchase(db, { provider: "web", providerTxId: tx, userId: user, coins });
const inv = async () => {
  const i = await L.checkInvariants(db);
  expect(i.globalSum).toBe(0n);
  expect(i.discrepancies).toEqual([]);
};

describe("real PostgreSQL: duplicates and concurrent purchases", () => {
  it("20 concurrent identical purchase webhooks credit exactly once", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => fund("u", 500n, "same")));
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await L.balanceOf(db, L.walletId("u"))).toBe(500n);
    await inv();
  });
  it("50 concurrent distinct purchases all apply", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => fund("u", 10n, `t${i}`)));
    expect(await L.balanceOf(db, L.walletId("u"))).toBe(500n);
    expect(await L.balanceOf(db, L.ISSUANCE)).toBe(-500n);
    await inv();
  });
});

describe("real PostgreSQL: gifts and double spending", () => {
  it("20 concurrent identical gift requests debit once", async () => {
    await fund("v", 1000n);
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      L.sendGift(db, { giftId: "same", fromUser: "v", creatorId: "c", coins: 100n })));
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(900n);
    await inv();
  });

  it("30 simultaneous 100-coin spends from a 1000-coin wallet: exactly 10 succeed", async () => {
    await fund("v", 1000n);
    const rs = await Promise.allSettled(Array.from({ length: 30 }, (_, i) =>
      L.sendGift(db, { giftId: `g${i}`, fromUser: "v", creatorId: "c", coins: 100n, familyId: "f", familyBps: 1000 })));
    const ok = rs.filter((r) => r.status === "fulfilled");
    const bad = rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(10);
    expect(bad.every((r) => r.reason instanceof L.InsufficientFundsError)).toBe(true);
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(0n);
    expect(await L.balanceOf(db, L.earningsId("c"))).toBe(630n);
    expect(await L.balanceOf(db, L.familyId("f"))).toBe(70n);
    expect(await L.balanceOf(db, L.PLATFORM)).toBe(300n);
    await inv();
  });

  it("many wallets spending to one creator concurrently stay consistent", async () => {
    const users = Array.from({ length: 10 }, (_, i) => `v${i}`);
    await Promise.all(users.map((u) => fund(u, 200n)));
    await Promise.allSettled(users.flatMap((u) => Array.from({ length: 5 }, (_, i) =>
      L.sendGift(db, { giftId: `${u}-${i}`, fromUser: u, creatorId: "c", coins: 50n }))));
    for (const u of users) expect(await L.balanceOf(db, L.walletId(u))).toBe(0n);
    expect(await L.balanceOf(db, L.earningsId("c"))).toBe(10n * 4n * 35n);
    await inv();
  });

  it("concurrent refund attempts of one entry reverse it once", async () => {
    await fund("v", 100n);
    const g = await L.sendGift(db, { giftId: "g", fromUser: "v", creatorId: "c", coins: 100n });
    const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      L.reverseEntry(db, { entryId: g.entryId, key: `refund-${i}`, reason: "t" })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(100n);
    await inv();
  });
});

describe("real PostgreSQL: row locking and isolation", () => {
  it("a second spender blocks on the row lock, then re-checks the balance", async () => {
    await fund("v", 1000n);
    await L.ensureAccount(db, L.PLATFORM, "platform_revenue");
    const holding = deferred(); const release = deferred();
    const a = db.transaction(async (tx) => {
      const e = await tx.query<{ id: number }>(`INSERT INTO journal_entries(idempotency_key,type) VALUES('A','x') RETURNING id`);
      await tx.query(`INSERT INTO postings(entry_id,account_id,amount) VALUES($1,'wallet:v',-600)`, [e.rows[0].id]);
      await tx.query(`INSERT INTO postings(entry_id,account_id,amount) VALUES($1,'platform:revenue',600)`, [e.rows[0].id]);
      holding.resolve(); await release.promise;
    });
    await holding.promise;
    let bDone = false;
    const b = L.sendGift(db, { giftId: "B", fromUser: "v", creatorId: "c", coins: 600n }).finally(() => (bDone = true));
    b.catch(() => {});
    await sleep(400);
    expect(bDone).toBe(false); // blocked on wallet:v row lock held by A
    const locks = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND state='active'`);
    expect(locks.rows[0].n).toBeGreaterThanOrEqual(1);
    release.resolve(); await a;
    await expect(b).rejects.toBeInstanceOf(L.InsufficientFundsError); // 400 left < 600
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(400n);
    await inv();
  });

  it("uncommitted writes are invisible to other connections (READ COMMITTED)", async () => {
    await fund("v", 100n);
    const holding = deferred(); const release = deferred();
    const a = db.transaction(async (tx) => {
      await tx.query(`UPDATE ledger_accounts SET owner_id='dirty' WHERE id='wallet:v'`);
      holding.resolve(); await release.promise;
    });
    await holding.promise;
    const r = await db.query(`SELECT owner_id FROM ledger_accounts WHERE id='wallet:v'`);
    expect(r.rows[0].owner_id).toBe("v");
    release.resolve(); await a;
  });

  it("deadlocks are detected and the adapter retries to success", async () => {
    await L.ensureAccount(db, "wallet:x", "user_wallet");
    await L.ensureAccount(db, "wallet:y", "user_wallet");
    const bar1 = deferred(), bar2 = deferred();
    let attempts = 0;
    const lock = (first: string, second: string, mine: ReturnType<typeof deferred<void>>, theirs: ReturnType<typeof deferred<void>>) =>
      db.transaction(async (tx) => {
        attempts++;
        await tx.query(`UPDATE ledger_accounts SET owner_id='t' WHERE id=$1`, [first]);
        mine.resolve(); await Promise.race([theirs.promise, sleep(1000)]);
        await tx.query(`UPDATE ledger_accounts SET owner_id='t' WHERE id=$1`, [second]);
      });
    await Promise.all([lock("wallet:x", "wallet:y", bar1, bar2), lock("wallet:y", "wallet:x", bar2, bar1)]);
    expect(attempts).toBeGreaterThan(2); // at least one victim was retried
  });
});

describe("real PostgreSQL: rollback", () => {
  it("failed gift leaves no journal entry, postings or balance change; key stays reusable", async () => {
    await fund("v", 50n);
    await expect(L.sendGift(db, { giftId: "r", fromUser: "v", creatorId: "c", coins: 100n })).rejects.toBeInstanceOf(L.InsufficientFundsError);
    expect((await db.query(`SELECT 1 FROM journal_entries WHERE idempotency_key='gift:r'`)).rows).toHaveLength(0);
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(50n);
    await fund("v", 100n, "topup");
    const ok = await L.sendGift(db, { giftId: "r", fromUser: "v", creatorId: "c", coins: 100n });
    expect(ok.replayed).toBe(false);
    await inv();
  });
  it("an unbalanced entry fails at commit and rolls everything back", async () => {
    await L.ensureAccount(db, "wallet:a", "user_wallet");
    await expect(db.transaction(async (tx) => {
      const e = await tx.query<{ id: number }>(`INSERT INTO journal_entries(idempotency_key,type) VALUES('bad','x') RETURNING id`);
      await tx.query(`INSERT INTO postings(entry_id,account_id,amount) VALUES($1,'wallet:a',5)`, [e.rows[0].id]);
    })).rejects.toThrow(/does not balance/);
    expect((await db.query(`SELECT 1 FROM journal_entries`)).rows).toHaveLength(0);
    expect(await L.balanceOf(db, "wallet:a")).toBe(0n);
  });
});

describe("real PostgreSQL: migrations", () => {
  it("reapplying (including 3 concurrent runs) preserves data and succeeds", async () => {
    await fund("u", 100n);
    await Promise.all([migrate(db), migrate(db), migrate(db)]);
    await migrate(db);
    expect(await L.balanceOf(db, L.walletId("u"))).toBe(100n);
    await inv();
  });
});

describe("real PostgreSQL: crash recovery", () => {
  it("committed data survives an immediate-mode restart; uncommitted work is discarded", async () => {
    await fund("u", 100n);
    const g = await L.sendGift(db, { giftId: "pre", fromUser: "u", creatorId: "c", coins: 40n });
    // in-flight, never committed
    const c = await db.pool.connect();
    await c.query("BEGIN");
    const e = await c.query(`INSERT INTO journal_entries(idempotency_key,type) VALUES('inflight','x') RETURNING id`);
    await c.query(`INSERT INTO postings(entry_id,account_id,amount) VALUES($1,'wallet:u',-10),($1,'platform:revenue',10)`, [e.rows[0].id]);

    execFileSync("bash", ["scripts/pg-test.sh", "crash"]);
    c.release(true);

    for (let i = 0; i < 20; i++) { try { await db.query("SELECT 1"); break; } catch { await sleep(250); } }
    expect(await L.balanceOf(db, L.walletId("u"))).toBe(60n);
    expect((await db.query(`SELECT 1 FROM journal_entries WHERE idempotency_key='inflight'`)).rows).toHaveLength(0);
    const replay = await L.sendGift(db, { giftId: "pre", fromUser: "u", creatorId: "c", coins: 40n });
    expect(replay).toEqual({ entryId: g.entryId, replayed: true });
    await inv();
  });
});
