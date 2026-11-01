import { Redis } from "ioredis";

export interface Limiter { allow(key: string, cost?: number): Promise<boolean> }

/**
 * In-memory token bucket. Correct for a single instance only; used standalone in dev/tests and as the
 * degraded-mode fallback when Redis is unreachable.
 */
export class RateLimiter implements Limiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number, private now: () => number = Date.now, private maxKeys = 50_000) {}
  async allow(key: string, cost = 1): Promise<boolean> { return this.allowSync(key, cost); }
  allowSync(key: string, cost = 1): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.clear(); // bounded memory under key-flood
      b = { tokens: this.perMinute, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
}

// Atomic token bucket on the Redis server clock, so instances with skewed clocks agree.
const LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local cap, cost = tonumber(ARGV[1]), tonumber(ARGV[2])
local d = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(d[1]) or cap
local at = tonumber(d[2]) or now
tokens = math.min(cap, tokens + ((now - at) / 60000) * cap)
local ok = 0
if tokens >= cost then tokens = tokens - cost; ok = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], 120000)
return ok`;

/** Shared limiter across API instances. On Redis failure it degrades to a per-instance bucket (never fails open unbounded). */
export class RedisRateLimiter implements Limiter {
  degraded = false;
  private fallback: RateLimiter;
  constructor(private redis: Redis, private perMinute: number, private prefix = "rl", fallback?: RateLimiter) {
    this.fallback = fallback ?? new RateLimiter(perMinute);
    redis.defineCommand("xtcBucket", { numberOfKeys: 1, lua: LUA });
  }
  async allow(key: string, cost = 1): Promise<boolean> {
    try {
      const r = await (this.redis as any).xtcBucket(`${this.prefix}:${key}`, this.perMinute, cost);
      this.degraded = false;
      return r === 1;
    } catch {
      this.degraded = true;
      return this.fallback.allowSync(key, cost);
    }
  }
}

export function makeRedis(url: string) {
  const r = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 250, connectTimeout: 500, retryStrategy: (n) => Math.min(n * 200, 2000), lazyConnect: false });
  r.on("error", () => {}); // outages are handled by the limiter's degraded mode
  return r;
}

/** Resolves once connected (or after timeoutMs); callers proceed in degraded mode if Redis is not up yet. */
export async function waitReady(r: Redis, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (r.status !== "ready" && Date.now() < end) await new Promise((x) => setTimeout(x, 25));
  return r.status === "ready";
}
