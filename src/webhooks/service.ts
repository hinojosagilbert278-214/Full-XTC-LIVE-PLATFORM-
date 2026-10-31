import type { PgDb } from "../db/pg";
import * as L from "../ledger/ledger";
import type { App } from "../api/app";
import { HttpError } from "../api/app";
import { verifyStripe, verifyRevenueCat, verifyApple, verifyGoogle, WebhookAuthError, ProviderNotConfigured, type Normalized, type KeyResolver, type PlayVerifier } from "./providers";
import { z } from "zod";

export const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 120;

export class RetryableWebhookError extends Error {}   // e.g. purchase not seen yet (out-of-order)
export class ReviewRequiredError extends Error {}     // needs a human / accounting decision

export interface WebhookDeps { playVerifier?: PlayVerifier; googleKeys?: KeyResolver; now?: () => number }

/** Persist a verified event. Returns false when it is a duplicate delivery. */
export async function ingest(db: PgDb, n: Normalized, raw: Buffer, simulated = false): Promise<{ id: number; duplicate: boolean }> {
  const status = n.kind === "ignore" ? "ignored" : "pending";
  const r = await db.query<{ id: string }>(
    `INSERT INTO webhook_events(provider,event_id,kind,ledger_provider,provider_tx_id,user_ref,sku,purchase_token,simulated,raw_body,status,processed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $11='ignored' THEN now() END)
     ON CONFLICT (provider,event_id) DO NOTHING RETURNING id`,
    [n.provider, n.eventId, n.kind, n.ledgerProvider ?? null, n.providerTxId ?? null, n.userRef ?? null, n.sku ?? null, n.purchaseToken ?? null, simulated, raw.toString("utf8"), status]);
  if (r.rows[0]) return { id: Number(r.rows[0].id), duplicate: false };
  const ex = await db.query<{ id: string }>(`SELECT id FROM webhook_events WHERE provider=$1 AND event_id=$2`, [n.provider, n.eventId]);
  return { id: Number(ex.rows[0].id), duplicate: true };
}

interface Row { id: string; provider: string; kind: string; ledger_provider: string | null; provider_tx_id: string | null; user_ref: string | null; sku: string | null; purchase_token: string | null; simulated: boolean; attempts: number }

/** Claims due events (SKIP LOCKED + lease so crashed workers' events are re-claimed) and processes each. */
export async function processDue(db: PgDb, deps: WebhookDeps = {}, limit = 20): Promise<{ processed: number; failed: number }> {
  const claimed = await db.query<Row>(
    `UPDATE webhook_events SET status='processing', attempts=attempts+1, locked_until=now() + make_interval(secs => $2)
      WHERE id IN (SELECT id FROM webhook_events
                    WHERE (status IN ('pending','retrying') AND next_attempt_at <= now())
                       OR (status='processing' AND locked_until < now())
                    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1)
      RETURNING id, provider, kind, ledger_provider, provider_tx_id, user_ref, sku, purchase_token, simulated, attempts`, [limit, LEASE_SECONDS]);
  let processed = 0, failed = 0;
  for (const ev of claimed.rows) {
    const attempt = Number(ev.attempts);
    try {
      const entryId = await handle(db, ev, deps);
      await db.transaction(async (tx) => {
        await tx.query(`UPDATE webhook_events SET status='processed', entry_id=$2, processed_at=now(), locked_until=NULL, last_error=NULL WHERE id=$1`, [ev.id, entryId]);
        await tx.query(`INSERT INTO webhook_event_attempts(event_id,attempt,outcome) VALUES($1,$2,'processed')`, [ev.id, attempt]);
      });
      processed++;
    } catch (e) {
      failed++;
      const msg = String((e as Error).message).slice(0, 500);
      const review = e instanceof ReviewRequiredError || e instanceof L.InsufficientFundsError || e instanceof ProviderNotConfigured;
      const exhausted = attempt >= MAX_ATTEMPTS;
      const status = review ? "needs_review" : exhausted ? (e instanceof RetryableWebhookError ? "needs_review" : "dead") : "retrying";
      const delaySec = Math.min(30 * 2 ** (attempt - 1), 3600);
      await db.transaction(async (tx) => {
        await tx.query(`UPDATE webhook_events SET status=$2, last_error=$3, locked_until=NULL, next_attempt_at=now() + make_interval(secs => $4) WHERE id=$1`, [ev.id, status, msg, delaySec]);
        await tx.query(`INSERT INTO webhook_event_attempts(event_id,attempt,outcome,error) VALUES($1,$2,$3,$4)`, [ev.id, attempt, status, msg]);
      });
    }
  }
  return { processed, failed };
}

async function handle(db: PgDb, ev: Row, deps: WebhookDeps): Promise<number> {
  let lp = ev.ledger_provider ?? "unknown", tx = ev.provider_tx_id, userRef = ev.user_ref;
  if (ev.simulated) lp = "simulation"; // simulated events can never collide with, or be mistaken for, real purchases

  if (ev.kind === "purchase") {
    if (ev.provider === "google" && !ev.simulated) {
      if (!deps.playVerifier) throw new ProviderNotConfigured("google play verifier (Play Developer API credentials)");
      const v = await deps.playVerifier.verify(ev.purchase_token ?? "", ev.sku ?? "");
      tx = v.orderId; userRef = v.userRef;
    }
    if (!tx || !userRef || !ev.sku) throw new ReviewRequiredError("purchase event missing transaction, user or sku");
    const mapped = await db.query<{ user_id: string }>(`SELECT user_id FROM app_account_tokens WHERE token=$1`, [userRef]);
    const userId = mapped.rows[0]?.user_id ?? userRef;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new ReviewRequiredError("cannot resolve a valid user for purchase");
    const p = await db.query<{ coins: string }>(`SELECT coins FROM products WHERE sku=$1 AND active`, [ev.sku]);
    if (!p.rows[0]) throw new ReviewRequiredError(`unknown sku ${ev.sku}`); // coin amount only from the server catalog
    return (await L.creditPurchase(db, { provider: lp, providerTxId: tx, userId, coins: BigInt(p.rows[0].coins) })).entryId;
  }

  if (ev.kind === "refund" || ev.kind === "chargeback") {
    if (!tx) throw new ReviewRequiredError("refund event without transaction id");
    const orig = await db.query<{ id: string }>(`SELECT id FROM journal_entries WHERE idempotency_key=$1`, [`purchase:${lp}:${tx}`]);
    // Out of order: refund delivered before the purchase. Retry with backoff until the purchase lands.
    if (!orig.rows[0]) throw new RetryableWebhookError("purchase not yet recorded");
    // InsufficientFundsError (coins already spent) is deliberately not forced negative: it parks as needs_review.
    return (await L.reverseEntry(db, { entryId: Number(orig.rows[0].id), key: `reversal:${lp}:${tx}`, reason: ev.kind })).entryId;
  }
  throw new ReviewRequiredError(`unsupported kind ${ev.kind}`);
}

/** Starts a polling worker. Returns a stop function. */
export function startWorker(db: PgDb, deps: WebhookDeps = {}, intervalMs = 2000) {
  let stopped = false, running = false;
  const t = setInterval(async () => {
    if (stopped || running) return;
    running = true;
    try { await processDue(db, deps); } catch (e) { console.error(JSON.stringify({ level: "error", msg: "webhook worker", err: (e as Error).message })); } finally { running = false; }
  }, intervalMs);
  return () => { stopped = true; clearInterval(t); };
}

/** Mounts /webhooks/* and the simulation endpoint. */
export function webhookRoutes(deps: WebhookDeps = {}) {
  return (app: App) => {
    const c = app.config;
    const keys: KeyResolver = deps.googleKeys ?? defaultGoogleKeys;

    const accept = (provider: string, verify: (ctx: { raw: Buffer; headers: any }) => Normalized | Promise<Normalized>) =>
      app.route("POST", `/webhooks/${provider}`, "none", async (ctx) => {
        let n: Normalized;
        try {
          n = await verify({ raw: ctx.rawBody, headers: ctx.req.headers });
        } catch (e) {
          if (e instanceof ProviderNotConfigured) throw new HttpError(503, "provider_not_configured");
          await app.audit({ action: "webhook.rejected", resource: provider, outcome: "denied", ip: ctx.ip, detail: { reason: e instanceof WebhookAuthError ? e.message : "unparseable" } });
          throw new HttpError(401, "invalid_signature"); // uniform response: no oracle for attackers
        }
        const r = await ingest(app.db, n, ctx.rawBody);
        return { body: { received: true, duplicate: r.duplicate } }; // processing is asynchronous
      }, { maxBody: 512 * 1024, mutation: false });

    accept("stripe", ({ raw, headers }) => verifyStripe(raw, headers, c.STRIPE_WEBHOOK_SECRET));
    accept("revenuecat", ({ raw, headers }) => verifyRevenueCat(raw, headers, c.REVENUECAT_WEBHOOK_AUTH));
    accept("apple", ({ raw }) => verifyApple(raw, c.APPLE_ROOT_CA_PEM, { production: c.NODE_ENV === "production" }));
    accept("google", ({ raw, headers }) => verifyGoogle(raw, headers, { audience: c.GOOGLE_PUBSUB_AUDIENCE, serviceAccount: c.GOOGLE_PUBSUB_SERVICE_ACCOUNT, keys }));

    // SIMULATION ONLY: authenticated admin injects a synthetic event through the same persist/process pipeline.
    // Disabled (404) unless WEBHOOK_SIMULATION=true, which loadConfig refuses in production.
    app.route("POST", "/v1/admin/webhooks/simulate", "admin", async (ctx) => {
      if (!c.simulation) throw new HttpError(404, "not_found");
      const b = ctx.json(z.object({
        eventId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), kind: z.enum(["purchase", "refund", "chargeback"]),
        providerTxId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), userId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), sku: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
      }).strict());
      const r = await ingest(app.db, { provider: "simulation", eventId: b.eventId, kind: b.kind, ledgerProvider: "stripe", providerTxId: b.providerTxId, userRef: b.userId, sku: b.sku }, ctx.rawBody, true);
      await app.audit({ actor: ctx.principal!.sub, action: "webhook.simulate", resource: `event:${r.id}`, outcome: "ok", ip: ctx.ip });
      return { status: 202, body: { simulated: true, ...r } };
    });
  };
}

// Google signing certs (PEM by kid). Network-dependent; untested against live Google, see docs/DEPENDENCIES.md.
let cache: { at: number; certs: Record<string, string> } | undefined;
const defaultGoogleKeys: KeyResolver = async (kid) => {
  if (!cache || Date.now() - cache.at > 3600_000) {
    const r = await fetch("https://www.googleapis.com/oauth2/v1/certs");
    if (!r.ok) return undefined;
    cache = { at: Date.now(), certs: (await r.json()) as Record<string, string> };
  }
  return cache.certs[kid];
};
