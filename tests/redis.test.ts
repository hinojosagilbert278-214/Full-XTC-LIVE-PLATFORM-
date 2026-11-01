import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app";
import { loadConfig } from "../src/config";
import { RedisRateLimiter, makeRedis, waitReady } from "../src/api/ratelimit";
import { freshDb } from "./pg/helper";
import { baseEnv, token, call } from "./pg/apihelper";
import type { PgDb } from "../src/db/pg";

const URL_ = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6390";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let db: PgDb; const closers: Array<() => Promise<unknown> | void> = [];
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { for (const c of closers) await c(); await db.close(); });
const uniq = () => `t${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
async function limiter(perMinute: number, prefix: string) {
  const r = makeRedis(URL_); closers.push(() => r.disconnect());
  expect(await waitReady(r)).toBe(true);
  return new RedisRateLimiter(r, perMinute, prefix);
}

describe("Redis rate limiter", () => {
  it("two instances share one budget and stay atomic under concurrency", async () => {
    const p = uniq(), a = await limiter(10, p), b = await limiter(10, p);
    await a.allow("warm"); await b.allow("warm");
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).allow("k")));
    expect(rs.filter(Boolean).length).toBe(10);
    expect(a.degraded || b.degraded).toBe(false);
  });
  it("different keys have independent budgets", async () => {
    const l = await limiter(2, uniq());
    expect([await l.allow("x"), await l.allow("x"), await l.allow("x"), await l.allow("y")]).toEqual([true, true, false, true]);
  });
  it("two real API instances enforce a single shared per-user limit", async () => {
    const p = uniq();
    const mk = async () => {
      const rc = makeRedis(URL_); closers.push(() => rc.disconnect()); await waitReady(rc);
      const app = createApp(db, loadConfig({ ...baseEnv, RATE_LIMIT_PER_MINUTE: "5" }), [], { limiter: (n, pm) => new RedisRateLimiter(rc, pm, `${p}:${n}`) });
      await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
      closers.push(() => new Promise((r) => app.server.close(r)));
      return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    };
    const [u1, u2] = [await mk(), await mk()], tok = token("rl-user");
    const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => call(i % 2 ? u1 : u2, "GET", "/v1/wallet", { tok })));
    expect(rs.filter((r) => r.status === 200).length).toBe(5);
    expect(rs.filter((r) => r.status === 429).length).toBe(9);
  });
  it("Redis outage degrades to a bounded local limit (never unlimited) and recovers when Redis returns", async () => {
    const l = await limiter(3, uniq());
    expect(await l.allow("o")).toBe(true);
    execFileSync("scripts/redis-test.sh", ["stop"]);
    const during = [] as boolean[];
    for (let i = 0; i < 6; i++) during.push(await l.allow("o2"));
    expect(l.degraded).toBe(true);
    expect(during.filter(Boolean).length).toBe(3);
    execFileSync("scripts/redis-test.sh", ["start"]);
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) { await sleep(250); await l.allow("recover"); ok = !l.degraded; }
    expect(ok).toBe(true);
  });
});
