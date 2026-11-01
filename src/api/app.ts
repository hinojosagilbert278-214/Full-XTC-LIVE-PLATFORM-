import http from "node:http";
import { z } from "zod";
import type { PgDb } from "../db/pg";
import type { Config } from "../config";
import * as L from "../ledger/ledger";
import { AuthError, verifyJwt, type Principal } from "./auth";
import { RateLimiter, type Limiter } from "./ratelimit";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

export interface Ctx {
  req: http.IncomingMessage;
  url: URL;
  params: Record<string, string>;
  principal: Principal | null;
  ip: string;
  rawBody: Buffer;
  json<T>(schema: z.ZodType<T>): T;
  idempotencyKey(): string;
}
export type Handler = (c: Ctx) => Promise<{ status?: number; body: unknown }>;
interface Route { method: string; re: RegExp; keys: string[]; auth: "user" | "admin" | "service_or_admin" | "none"; maxBody: number; mutation: boolean; h: Handler }

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const COINS = z.number().int().positive().max(1_000_000);
const json = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export interface App {
  server: http.Server;
  db: PgDb;
  config: Config;
  audit(a: { actor?: string | null; action: string; resource?: string; outcome: string; ip?: string; detail?: object }): Promise<void>;
  route(method: string, path: string, auth: Route["auth"], h: Handler, o?: { maxBody?: number; mutation?: boolean }): void;
}

export function createApp(db: PgDb, config: Config, extra: Array<(app: App) => void> = [], opts: { limiter?: (name: string, perMinute: number) => Limiter } = {}): App {
  const routes: Route[] = [];
  const mk = opts.limiter ?? ((_n: string, pm: number) => new RateLimiter(pm));
  const limiter = mk("general", config.RATE_LIMIT_PER_MINUTE);
  const mutationLimiter = mk("mutation", Math.min(30, config.RATE_LIMIT_PER_MINUTE));
  const origins = new Set(config.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));

  const app: App = {
    db, config,
    server: null as unknown as http.Server,
    async audit(a) {
      try {
        await db.query(`INSERT INTO audit_log(actor,action,resource,outcome,ip,detail) VALUES($1,$2,$3,$4,$5,$6)`,
          [a.actor ?? null, a.action, a.resource ?? null, a.outcome, a.ip ?? null, JSON.stringify(a.detail ?? {}, json)]);
      } catch (e) { console.error(JSON.stringify({ level: "error", msg: "audit write failed", err: String((e as Error).message) })); }
    },
    route(method, path, auth, h, o = {}) {
      const keys: string[] = [];
      const re = new RegExp("^" + path.replace(/:([a-z]+)/gi, (_m, k) => (keys.push(k), "([^/]+)")) + "$");
      routes.push({ method, re, keys, auth, maxBody: o.maxBody ?? 16 * 1024, mutation: o.mutation ?? method !== "GET", h });
    },
  };

  registerWalletRoutes(app);
  extra.forEach((f) => f(app));

  app.server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        "content-type": "application/json", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "strict-transport-security": "max-age=63072000", ...headers,
      });
      res.end(JSON.stringify(body, json));
    };
    let principal: Principal | null = null;
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const origin = req.headers.origin;
      const cors: Record<string, string> = {};
      if (origin && origins.has(origin)) Object.assign(cors, { "access-control-allow-origin": origin, vary: "origin", "access-control-allow-headers": "authorization,content-type,idempotency-key" });
      if (req.method === "OPTIONS") return send(204, {}, cors);

      let route: Route | undefined, params: Record<string, string> = {};
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        route = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        break;
      }
      if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "method_not_allowed" : "not_found");

      if (route.auth !== "none") {
        // Unauthenticated callers are throttled by IP before any crypto work.
        if (!(await limiter.allow(`ip:${ip}`))) throw new HttpError(429, "rate_limited");
        const h = req.headers.authorization ?? "";
        if (!h.startsWith("Bearer ")) throw new HttpError(401, "unauthenticated");
        try {
          principal = verifyJwt(h.slice(7), { secret: config.JWT_SECRET, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
        } catch (e) {
          await app.audit({ action: "auth.failed", outcome: "denied", ip, detail: { reason: (e as AuthError).message } });
          throw new HttpError(401, "unauthenticated");
        }
        const ok = route.auth === "user" || (route.auth === "admin" && principal.role === "admin") ||
          (route.auth === "service_or_admin" && (principal.role === "admin" || principal.role === "service"));
        if (!ok) {
          await app.audit({ actor: principal.sub, action: "authz.denied", resource: url.pathname, outcome: "denied", ip });
          throw new HttpError(403, "forbidden");
        }
        if (!(await limiter.allow(`sub:${principal.sub}`))) throw new HttpError(429, "rate_limited");
        if (route.mutation && !(await mutationLimiter.allow(`mut:${principal.sub}`))) throw new HttpError(429, "rate_limited");
      } else if (!(await limiter.allow(`ip:${ip}`, 1))) throw new HttpError(429, "rate_limited");

      const rawBody = await readBody(req, route.maxBody);
      const ctx: Ctx = {
        req, url, params, principal, ip, rawBody,
        json<T>(schema: z.ZodType<T>) {
          if (!/^application\/json/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "unsupported_media_type");
          let parsed: unknown;
          try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { throw new HttpError(400, "invalid_json"); }
          const r = schema.safeParse(parsed);
          if (!r.success) throw new HttpError(422, "validation_failed", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
          return r.data;
        },
        idempotencyKey() {
          const k = req.headers["idempotency-key"];
          const r = ID.safeParse(Array.isArray(k) ? k[0] : k);
          if (!r.success) throw new HttpError(400, "idempotency_key_required", "Idempotency-Key header (1-64 chars A-Za-z0-9_-) is required");
          return r.data;
        },
      };
      const out = await route.h(ctx);
      send(out.status ?? 200, out.body, cors);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message });
      if (e instanceof L.InvalidSplitError) return send(422, { error: "validation_failed", message: e.message });
      if (e instanceof L.InsufficientFundsError) return send(409, { error: "insufficient_funds" });
      if (e instanceof L.IdempotencyConflictError) return send(409, { error: "idempotency_conflict" });
      console.error(JSON.stringify({ level: "error", msg: "unhandled", err: (e as Error).message }));
      send(500, { error: "internal_error" }); // never leak internals
    }
  });
  return app;
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0; let tooBig = false;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) { tooBig = true; chunks.length = 0; return; } // keep draining so the 413 can be delivered
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => (tooBig ? reject(new HttpError(413, "payload_too_large")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

const familyFor = async (db: PgDb, creatorId: string) => {
  const r = await db.query<{ family_id: string; share_bps: number }>(
    `SELECT m.family_id, f.share_bps FROM family_memberships m JOIN families f ON f.id=m.family_id WHERE m.user_id=$1`, [creatorId]);
  return r.rows[0] ? { familyId: r.rows[0].family_id, bps: Number(r.rows[0].share_bps) } : undefined;
};

function registerWalletRoutes(app: App) {
  const { db } = app;
  const me = (c: Ctx) => c.principal!.sub;

  app.route("GET", "/healthz", "none", async () => { await db.query("SELECT 1"); return { body: { ok: true } }; });

  app.route("GET", "/v1/wallet", "user", async (c) => {
    await L.ensureAccount(db, L.walletId(me(c)), "user_wallet", me(c));
    return { body: { userId: me(c), balance: await L.balanceOf(db, L.walletId(me(c))) } };
  });

  app.route("GET", "/v1/wallet/transactions", "user", async (c) => {
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(c.url.searchParams.get("limit") ?? undefined);
    const before = z.coerce.number().int().positive().optional().parse(c.url.searchParams.get("before") ?? undefined);
    const r = await db.query(
      `SELECT p.id, p.entry_id AS "entryId", e.type, a.kind AS account, p.role, p.amount, e.created_at AS "at"
         FROM postings p JOIN ledger_accounts a ON a.id=p.account_id JOIN journal_entries e ON e.id=p.entry_id
        WHERE a.owner_id=$1 AND a.kind IN ('user_wallet','creator_earnings') AND ($2::bigint IS NULL OR p.id < $2)
        ORDER BY p.id DESC LIMIT $3`, [me(c), before ?? null, limit]);
    return { body: { items: r.rows, nextBefore: r.rows.length === limit ? r.rows[r.rows.length - 1].id : null } };
  });

  // Resource-level authz: only entries that touch one of the caller's own accounts; other parties' postings are never shown.
  app.route("GET", "/v1/transactions/:id", "user", async (c) => {
    const id = z.coerce.number().int().positive().safeParse(c.params.id);
    if (!id.success) throw new HttpError(404, "not_found");
    const r = await db.query(
      `SELECT e.id, e.type, e.created_at AS "at",
              EXISTS(SELECT 1 FROM journal_entries r WHERE r.reverses_entry=e.id) AS reversed
         FROM journal_entries e WHERE e.id=$1
          AND EXISTS (SELECT 1 FROM postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.entry_id=e.id AND a.owner_id=$2)`, [id.data, me(c)]);
    if (!r.rows[0]) throw new HttpError(404, "not_found"); // 404, not 403: do not reveal existence
    const mine = await db.query(
      `SELECT a.kind AS account, p.role, p.amount FROM postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE p.entry_id=$1 AND a.owner_id=$2`, [id.data, me(c)]);
    return { body: { ...r.rows[0], status: r.rows[0].reversed ? "reversed" : "completed", postings: mine.rows } };
  });

  // Transparent split disclosure computed server-side from the creator's family membership.
  app.route("GET", "/v1/gifts/quote", "user", async (c) => {
    const q = z.object({ coins: z.coerce.number().int().positive().max(1_000_000), creatorId: ID }).parse(Object.fromEntries(c.url.searchParams));
    const fam = await familyFor(db, q.creatorId);
    return { body: { coins: q.coins, familyId: fam?.familyId ?? null, familyBps: fam?.bps ?? 0, split: L.splitGift(BigInt(q.coins), fam?.bps ?? 0) } };
  });

  app.route("POST", "/v1/gifts", "user", async (c) => {
    const key = c.idempotencyKey();
    const b = c.json(z.object({ creatorId: ID, coins: COINS }).strict());
    if (b.creatorId === me(c)) throw new HttpError(422, "validation_failed", "cannot gift yourself");
    const fam = await familyFor(db, b.creatorId); // share is server-determined, never client-supplied
    try {
      const r = await L.sendGift(db, { giftId: `${me(c)}:${key}`, fromUser: me(c), creatorId: b.creatorId, coins: BigInt(b.coins), familyId: fam?.familyId, familyBps: fam?.bps });
      await app.audit({ actor: me(c), action: "gift.send", resource: `entry:${r.entryId}`, outcome: r.replayed ? "replayed" : "ok", ip: c.ip, detail: { coins: b.coins, creatorId: b.creatorId } });
      return { status: r.replayed ? 200 : 201, body: { entryId: r.entryId, replayed: r.replayed, split: L.splitGift(BigInt(b.coins), fam?.bps ?? 0) } };
    } catch (e) {
      await app.audit({ actor: me(c), action: "gift.send", outcome: "failed", ip: c.ip, detail: { reason: (e as Error).constructor.name } });
      throw e;
    }
  });

  app.route("GET", "/v1/creators/me/earnings", "user", async (c) => {
    const bal = await L.balanceOf(db, L.earningsId(me(c)));
    const life = await db.query<{ creator: string; gifts: string }>(
      `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.role='creator_share'),0) AS creator, COUNT(*) FILTER (WHERE p.role='creator_share') AS gifts
         FROM postings p WHERE p.account_id=$1`, [L.earningsId(me(c))]);
    // pending/available split is an open business decision (docs/ACCOUNTING_RULES.md); balance is the undifferentiated total.
    return { body: { balance: bal, lifetimeGrossCreatorShare: life.rows[0].creator, giftCount: Number(life.rows[0].gifts), pendingAvailableSplit: "undecided" } };
  });

  app.route("GET", "/v1/families/:id/earnings", "user", async (c) => {
    const fid = ID.safeParse(c.params.id);
    if (!fid.success) throw new HttpError(404, "not_found");
    if (c.principal!.role !== "admin") {
      const m = await db.query<{ role: string }>(`SELECT role FROM family_memberships WHERE user_id=$1 AND family_id=$2`, [me(c), fid.data]);
      if (!m.rows[0] || !["leader", "co_leader"].includes(m.rows[0].role)) throw new HttpError(404, "not_found");
    }
    return { body: { familyId: fid.data, balance: await L.balanceOf(db, L.familyId(fid.data)) } };
  });

  app.route("POST", "/v1/refunds", "user", async (c) => {
    const key = c.idempotencyKey();
    const b = c.json(z.object({ entryId: z.number().int().positive(), reason: z.string().min(3).max(500) }).strict());
    // Only the payer of a gift may request its refund.
    const own = await db.query(
      `SELECT 1 FROM journal_entries e JOIN postings p ON p.entry_id=e.id JOIN ledger_accounts a ON a.id=p.account_id
        WHERE e.id=$1 AND e.type='gift' AND a.kind='user_wallet' AND a.owner_id=$2 AND p.amount<0`, [b.entryId, me(c)]);
    if (!own.rows[0]) throw new HttpError(404, "not_found");
    const ins = await db.query(
      `INSERT INTO refund_requests(entry_id,requested_by,idempotency_key,reason) VALUES($1,$2,$3,$4)
       ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING id, status`, [b.entryId, me(c), key, b.reason]).catch((e) => {
      if (e.code === "23505") throw new HttpError(409, "refund_already_requested");
      throw e;
    });
    const row = ins.rows[0] ?? (await db.query(`SELECT id,status FROM refund_requests WHERE requested_by=$1 AND idempotency_key=$2`, [me(c), key])).rows[0];
    await app.audit({ actor: me(c), action: "refund.request", resource: `entry:${b.entryId}`, outcome: ins.rows[0] ? "ok" : "replayed", ip: c.ip });
    return { status: ins.rows[0] ? 202 : 200, body: { refundId: Number(row.id), status: row.status } };
  });

  app.route("GET", "/v1/refunds/:id", "user", async (c) => {
    const r = await db.query(`SELECT id, entry_id AS "entryId", status, created_at AS "createdAt", decided_at AS "decidedAt" FROM refund_requests WHERE id=$1 AND requested_by=$2`,
      [Number(c.params.id) || 0, me(c)]);
    if (!r.rows[0]) throw new HttpError(404, "not_found");
    return { body: r.rows[0] };
  });

  app.route("POST", "/v1/admin/refunds/:id/decision", "admin", async (c) => {
    const b = c.json(z.object({ approve: z.boolean() }).strict());
    const id = Number(c.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "not_found");
    const lock = await db.query<{ status: string; entry_id: string }>(`SELECT status, entry_id FROM refund_requests WHERE id=$1`, [id]);
    if (!lock.rows[0]) throw new HttpError(404, "not_found");
    if (lock.rows[0].status !== "pending") throw new HttpError(409, "not_pending");
    const decide = async (status: string, reversal?: number) => {
      const u = await db.query(`UPDATE refund_requests SET status=$2, decided_by=$3, decided_at=now(), reversal_entry=$4 WHERE id=$1 AND status='pending' RETURNING id`, [id, status, c.principal!.sub, reversal ?? null]);
      return u.rows.length > 0;
    };
    if (!b.approve) {
      if (!(await decide("rejected"))) throw new HttpError(409, "not_pending");
      await app.audit({ actor: c.principal!.sub, action: "refund.reject", resource: `refund:${id}`, outcome: "ok", ip: c.ip });
      return { body: { refundId: id, status: "rejected" } };
    }
    try {
      // Key is derived from the refund id, so concurrent/retried approvals reverse exactly once.
      const r = await L.reverseEntry(db, { entryId: Number(lock.rows[0].entry_id), key: `refund:${id}`, reason: "approved refund" });
      await decide("completed", r.entryId);
      await app.audit({ actor: c.principal!.sub, action: "refund.approve", resource: `refund:${id}`, outcome: "ok", ip: c.ip, detail: { reversalEntry: r.entryId } });
      return { body: { refundId: id, status: "completed", reversalEntry: r.entryId } };
    } catch (e) {
      if (e instanceof L.InsufficientFundsError) {
        // Policy for already-spent funds is an open business decision; park for manual review, never go negative.
        await decide("needs_review");
        await app.audit({ actor: c.principal!.sub, action: "refund.approve", resource: `refund:${id}`, outcome: "needs_review", ip: c.ip });
        throw new HttpError(409, "needs_manual_review", "funds already spent or paid out; accounting policy decision required");
      }
      throw e;
    }
  });

  // Manual crediting for reconciliation; amount always comes from the server catalog.
  app.route("POST", "/v1/admin/purchases", "service_or_admin", async (c) => {
    const b = c.json(z.object({ provider: z.enum(["stripe", "apple", "google", "revenuecat", "manual"]), providerTxId: ID, userId: ID, sku: ID }).strict());
    const p = await db.query<{ coins: string }>(`SELECT coins FROM products WHERE sku=$1 AND active`, [b.sku]);
    if (!p.rows[0]) throw new HttpError(422, "unknown_sku");
    const r = await L.creditPurchase(db, { provider: b.provider, providerTxId: b.providerTxId, userId: b.userId, coins: BigInt(p.rows[0].coins) });
    await app.audit({ actor: c.principal!.sub, action: "purchase.credit", resource: `entry:${r.entryId}`, outcome: r.replayed ? "replayed" : "ok", ip: c.ip, detail: b });
    return { status: r.replayed ? 200 : 201, body: { entryId: r.entryId, replayed: r.replayed } };
  });

  app.route("GET", "/v1/admin/reconciliation", "admin", async () => {
    const inv = await L.checkInvariants(db);
    const kinds = await db.query(`SELECT kind, SUM(balance)::text AS total, COUNT(*)::int AS accounts FROM ledger_accounts GROUP BY kind ORDER BY kind`);
    const issued = await L.balanceOf(db, L.ISSUANCE);
    const refunds = await db.query(`SELECT status, COUNT(*)::int AS n FROM refund_requests GROUP BY status`);
    const events = await db.query(`SELECT status, COUNT(*)::int AS n FROM webhook_events GROUP BY status`).catch(() => ({ rows: [] }));
    return { body: {
      ok: inv.globalSum === 0n && inv.discrepancies.length === 0,
      globalSum: inv.globalSum, discrepancies: inv.discrepancies,
      coinsIssued: -issued, liabilitiesByKind: kinds.rows, refundRequests: refunds.rows, webhookEvents: events.rows,
    } };
  });
}
