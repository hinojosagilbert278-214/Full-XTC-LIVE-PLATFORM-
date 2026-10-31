/**
 * In-memory token bucket. Correct for a single instance only; multi-instance
 * deployments must back this with Redis (see docs/DEPENDENCIES.md).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number, private now: () => number = Date.now, private maxKeys = 50_000) {}
  allow(key: string, cost = 1): boolean {
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
