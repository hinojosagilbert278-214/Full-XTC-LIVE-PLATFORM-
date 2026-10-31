import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import * as L from "../src/ledger/ledger";

const migration = readFileSync(new URL("../migrations/001_ledger.sql", import.meta.url), "utf8");
let db: PGlite;
beforeEach(async () => { db = new PGlite(); await db.exec(migration); });

describe("migration", () => {
  it("is safely re-appliable", async () => {
    await db.exec(migration);
    await db.exec(migration);
  });
});

describe("splitGift", () => {
  it("70/30 with no family", () => {
    expect(L.splitGift(100n, 0)).toEqual({ creator: 70n, family: 0n, platform: 30n });
  });
  it("family takes up to 10% of the creator share", () => {
    expect(L.splitGift(100n, 1000)).toEqual({ creator: 63n, family: 7n, platform: 30n });
  });
  it("always sums to input, rounding to platform", () => {
    for (let c = 1n; c < 500n; c++) for (const bps of [0, 1, 333, 1000]) {
      const s = L.splitGift(c, bps);
      expect(s.creator + s.family + s.platform).toBe(c);
      expect(s.creator >= 0n && s.family >= 0n).toBe(true);
    }
  });
  it("rejects family share above 10%", () => {
    expect(() => L.splitGift(100n, 1001)).toThrow(L.InvalidSplitError);
  });
});

describe("purchases", () => {
  it("credits once per provider transaction (webhook replay)", async () => {
    const o = { provider: "apple", providerTxId: "tx1", userId: "u1", coins: 500n };
    const a = await L.creditPurchase(db as any, o);
    const b = await L.creditPurchase(db as any, o);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(await L.balanceOf(db, L.walletId("u1"))).toBe(500n);
  });
  it("rejects key reuse with a different payload", async () => {
    await L.creditPurchase(db as any, { provider: "apple", providerTxId: "tx1", userId: "u1", coins: 500n });
    await expect(L.creditPurchase(db as any, { provider: "apple", providerTxId: "tx1", userId: "u1", coins: 900n })).rejects.toThrow(/different payload/);
  });
});

describe("gifts", () => {
  beforeEach(async () => { await L.creditPurchase(db as any, { provider: "web", providerTxId: "p", userId: "v", coins: 1000n }); });

  it("records creator, family and platform shares separately and balances", async () => {
    await L.sendGift(db as any, { giftId: "g1", fromUser: "v", creatorId: "c", coins: 100n, familyId: "f", familyBps: 1000 });
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(900n);
    expect(await L.balanceOf(db, L.earningsId("c"))).toBe(63n);
    expect(await L.balanceOf(db, L.familyId("f"))).toBe(7n);
    expect(await L.balanceOf(db, L.PLATFORM)).toBe(30n);
    const inv = await L.checkInvariants(db);
    expect(inv.globalSum).toBe(0n);
    expect(inv.discrepancies).toEqual([]);
  });

  it("prevents double spending", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => L.sendGift(db as any, { giftId: `s${i}`, fromUser: "v", creatorId: "c", coins: 300n })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.every((r) => r.reason instanceof L.InsufficientFundsError)).toBe(true);
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(100n);
    expect((await L.checkInvariants(db)).discrepancies).toEqual([]);
  });

  it("is idempotent on retried gifts", async () => {
    await L.sendGift(db as any, { giftId: "dup", fromUser: "v", creatorId: "c", coins: 100n });
    const r = await L.sendGift(db as any, { giftId: "dup", fromUser: "v", creatorId: "c", coins: 100n });
    expect(r.replayed).toBe(true);
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(900n);
  });

  it("refund reverses all postings once", async () => {
    const g = await L.sendGift(db as any, { giftId: "r1", fromUser: "v", creatorId: "c", coins: 100n, familyId: "f", familyBps: 500 });
    await L.reverseEntry(db as any, { entryId: g.entryId, key: "refund:r1", reason: "test" });
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(1000n);
    expect(await L.balanceOf(db, L.earningsId("c"))).toBe(0n);
    await expect(L.reverseEntry(db as any, { entryId: g.entryId, key: "refund:r1-again", reason: "x" })).rejects.toThrow();
    expect(await L.balanceOf(db, L.walletId("v"))).toBe(1000n);
  });

  it("refuses refund that would make creator earnings negative", async () => {
    const g = await L.sendGift(db as any, { giftId: "r2", fromUser: "v", creatorId: "c", coins: 100n });
    await db.query(`UPDATE ledger_accounts SET balance = 0 WHERE id = $1`, [L.earningsId("c")]); // simulate payout drift
    await expect(L.reverseEntry(db as any, { entryId: g.entryId, key: "refund:r2", reason: "x" })).rejects.toBeInstanceOf(L.InsufficientFundsError);
  });
});

describe("ledger integrity", () => {
  it("rejects unbalanced entries at the database level", async () => {
    await L.ensureAccount(db, "wallet:a", "user_wallet");
    await expect(db.transaction(async (tx) => {
      const e = await tx.query<{ id: number }>(`INSERT INTO journal_entries(idempotency_key,type) VALUES('bad','x') RETURNING id`);
      await tx.query(`INSERT INTO postings(entry_id,account_id,amount) VALUES($1,'wallet:a',5)`, [e.rows[0].id]);
    })).rejects.toThrow(/does not balance/);
  });
  it("forbids updating or deleting postings and entries", async () => {
    await L.creditPurchase(db as any, { provider: "web", providerTxId: "z", userId: "u", coins: 5n });
    await expect(db.query(`DELETE FROM postings`)).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE postings SET amount = 9`)).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE journal_entries SET type='x'`)).rejects.toThrow(/append-only/);
  });
});
