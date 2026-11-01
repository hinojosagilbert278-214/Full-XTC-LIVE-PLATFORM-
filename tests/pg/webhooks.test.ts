import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac, generateKeyPairSync, createSign, sign as cSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, call, token, SECRET } from "./apihelper";
import { webhookRoutes, processDue, MAX_ATTEMPTS } from "../../src/webhooks/service";
import * as L from "../../src/ledger/ledger";
import { loadConfig } from "../../src/config";
import { signJwt } from "../../src/api/auth";

// ----- fixtures: Apple-style cert chain via openssl -----
const dir = mkdtempSync(join(tmpdir(), "xtc-pki-"));
const sh = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
function pki(prefix: string) {
  const f = (n: string) => `${prefix}-${n}`;
  sh("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f("root.key"));
  sh("req", "-x509", "-new", "-key", f("root.key"), "-subj", `/CN=${prefix}root`, "-days", "30", "-out", f("root.pem"), "-addext", "basicConstraints=critical,CA:TRUE");
  for (const [name, parent, ca] of [["int", "root", "CA:TRUE"], ["leaf", "int", "CA:FALSE"]] as const) {
    sh("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f(`${name}.key`));
    sh("req", "-new", "-key", f(`${name}.key`), "-subj", `/CN=${prefix}${name}`, "-out", f(`${name}.csr`));
    execFileSync("bash", ["-c", `printf 'basicConstraints=${ca}\n' > ${f(name)}.ext`], { cwd: dir });
    sh("x509", "-req", "-in", f(`${name}.csr`), "-CA", f(`${parent}.pem`), "-CAkey", f(`${parent}.key`), "-CAcreateserial", "-days", "30", "-out", f(`${name}.pem`), "-extfile", f(`${name}.ext`));
  }
  const rd = (n: string) => readFileSync(join(dir, f(n)), "utf8");
  const der = (n: string) => rd(n).replace(/-----[A-Z ]+-----|\s/g, "");
  return { rootPem: rd("root.pem"), x5c: [der("leaf.pem"), der("int.pem"), der("root.pem")], leafKey: rd("leaf.key") };
}
const apple = pki("a"), evil = pki("e");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jws(payload: object, chain = apple) {
  const h = b64({ alg: "ES256", x5c: chain.x5c }), p = b64(payload);
  return `${h}.${p}.${cSign("sha256", Buffer.from(`${h}.${p}`), { key: chain.leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
const appleBody = (o: { uuid: string; type: string; txId: string; sku?: string; token?: string; env?: string; chain?: typeof apple }) =>
  JSON.stringify({ signedPayload: jws({ notificationType: o.type, notificationUUID: o.uuid, data: { environment: o.env ?? "Production", signedTransactionInfo: jws({ transactionId: o.txId, productId: o.sku ?? "coins_500", appAccountToken: o.token ?? "tok-zed", environment: o.env ?? "Production" }, o.chain ?? apple) } }, o.chain ?? apple) });

// Google OIDC fixtures
const g = generateKeyPairSync("rsa", { modulusLength: 2048 });
const gPub = g.publicKey.export({ type: "spki", format: "pem" }) as string;
const GA = { aud: "https://xtc.example/webhooks/google", email: "pubsub@proj.iam.gserviceaccount.com" };
const gTok = (over: object = {}, key = g.privateKey) => {
  const h = b64({ alg: "RS256", kid: "k1" }), p = b64({ iss: "https://accounts.google.com", aud: GA.aud, email: GA.email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 300, ...over });
  return `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(key).toString("base64url")}`;
};
const gBody = (messageId: string, notification: object) => JSON.stringify({ message: { messageId, data: Buffer.from(JSON.stringify(notification)).toString("base64") } });

const STRIPE = "whsec_test_secret_value";
const RC = "rc-shared-secret";
const stripeSig = (raw: string, t = Math.floor(Date.now() / 1000), secret = STRIPE) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const stripeEvent = (id: string, type: string, obj: object) => JSON.stringify({ id, type, data: { object: obj } });
const stripePurchase = (id: string, pi: string, user = "zed", sku = "coins_500") => stripeEvent(id, "checkout.session.completed", { id: "cs_" + id, payment_intent: pi, payment_status: "paid", metadata: { user_id: user, sku, coins: "999999" } });

let s: Awaited<ReturnType<typeof startApp>>;
const verifier = { verify: async (_t: string, _s: string) => ({ orderId: "GPA.1", userRef: "zed" }) };
beforeAll(async () => {
  s = await startApp({ STRIPE_WEBHOOK_SECRET: STRIPE, REVENUECAT_WEBHOOK_AUTH: RC, APPLE_ROOT_CA_PEM: apple.rootPem, GOOGLE_PUBSUB_AUDIENCE: GA.aud, GOOGLE_PUBSUB_SERVICE_ACCOUNT: GA.email, WEBHOOK_SIMULATION: "true" },
    [webhookRoutes({ googleKeys: async (kid) => (kid === "k1" ? gPub : undefined) })]);
});
afterAll(async () => { await s.close(); });
beforeEach(async () => {
  await s.db.query(`BEGIN; SELECT set_config('xtc.allow_destructive','on',true); TRUNCATE webhook_event_attempts, webhook_events, app_account_tokens, products, refund_requests, postings, journal_entries, ledger_accounts, audit_log RESTART IDENTITY CASCADE; COMMIT`);
  await s.db.query(`INSERT INTO products(sku,coins) VALUES('coins_500',500)`);
  await s.db.query(`INSERT INTO app_account_tokens(token,user_id) VALUES('tok-zed','zed')`);
});
const post = (path: string, raw: string, headers: Record<string, string> = {}) => call(s.url, "POST", path, { raw, headers });
const bal = (u = "zed") => L.balanceOf(s.db, L.walletId(u));
const st = async (provider: string, ev: string) => (await s.db.query(`SELECT status, attempts, last_error FROM webhook_events WHERE provider=$1 AND event_id=$2`, [provider, ev])).rows[0];
const inv = async () => { const i = await L.checkInvariants(s.db); expect(i.globalSum).toBe(0n); expect(i.discrepancies).toEqual([]); };

describe("Stripe signature verification", () => {
  it("rejects bad signature, wrong secret, stale timestamp, tampered body and missing header", async () => {
    const raw = stripePurchase("evt_1", "pi_1");
    const cases: Record<string, string>[] = [{}, { "stripe-signature": "t=1,v1=00" }, { "stripe-signature": stripeSig(raw, undefined, "wrong") }, { "stripe-signature": stripeSig(raw, Math.floor(Date.now() / 1000) - 3600) }, { "stripe-signature": stripeSig(raw + " ") }];
    for (const h of cases) expect((await post("/webhooks/stripe", raw, h)).status).toBe(401);
    expect((await s.db.query(`SELECT 1 FROM webhook_events`)).rows).toHaveLength(0);
    expect((await s.db.query(`SELECT 1 FROM audit_log WHERE action='webhook.rejected'`)).rows.length).toBeGreaterThanOrEqual(5);
  });
  it("a user JWT is not a substitute for a signature", async () => {
    expect((await call(s.url, "POST", "/webhooks/stripe", { tok: token("root", "admin"), raw: stripePurchase("e", "p") })).status).toBe(401);
  });
});

describe("ingestion, dedupe and async processing", () => {
  it("persists first and credits only when processed; coin amount comes from the catalog, not the payload", async () => {
    const raw = stripePurchase("evt_2", "pi_2");
    const r = await post("/webhooks/stripe", raw, { "stripe-signature": stripeSig(raw) });
    expect(r.body).toEqual({ received: true, duplicate: false });
    expect(await bal()).toBe(0n); // not processed inline
    await processDue(s.db);
    expect(await bal()).toBe(500n); // metadata.coins=999999 ignored
    expect((await st("stripe", "evt_2")).status).toBe("processed");
    expect((await s.db.query(`SELECT outcome FROM webhook_event_attempts`)).rows).toEqual([{ outcome: "processed" }]);
    await inv();
  });
  it("20 concurrent duplicate deliveries -> one event row, one credit; two workers racing -> one credit", async () => {
    const raw = stripePurchase("evt_3", "pi_3");
    const rs = await Promise.all(Array.from({ length: 20 }, () => post("/webhooks/stripe", raw, { "stripe-signature": stripeSig(raw) })));
    expect(rs.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect((await s.db.query(`SELECT 1 FROM webhook_events`)).rows).toHaveLength(1);
    await Promise.all([processDue(s.db), processDue(s.db), processDue(s.db)]);
    expect(await bal()).toBe(500n);
  });
  it("same purchase under a different event id is still credited once", async () => {
    for (const id of ["evt_a", "evt_b"]) { const raw = stripePurchase(id, "pi_same"); await post("/webhooks/stripe", raw, { "stripe-signature": stripeSig(raw) }); }
    await processDue(s.db);
    expect(await bal()).toBe(500n);
  });
  it("ignores irrelevant event types and unpaid sessions", async () => {
    const raw = stripeEvent("evt_x", "customer.created", {});
    await post("/webhooks/stripe", raw, { "stripe-signature": stripeSig(raw) });
    expect((await st("stripe", "evt_x")).status).toBe("ignored");
  });
});

describe("unauthorized coin issuance is prevented", () => {
  it("unknown SKU or unresolvable user is parked for review with no credit", async () => {
    const raw = stripePurchase("evt_4", "pi_4", "zed", "coins_free");
    await post("/webhooks/stripe", raw, { "stripe-signature": stripeSig(raw) });
    const raw2 = stripePurchase("evt_5", "pi_5", "bad:user");
    await post("/webhooks/stripe", raw2, { "stripe-signature": stripeSig(raw2) });
    await processDue(s.db);
    expect((await st("stripe", "evt_4")).status).toBe("needs_review");
    expect(await bal()).toBe(0n);
    expect((await s.db.query(`SELECT 1 FROM journal_entries`)).rows).toHaveLength(0);
  });
  it("unconfigured providers return 503 rather than trusting the request", async () => {
    const bare = await startApp({}, [webhookRoutes()]);
    expect((await call(bare.url, "POST", "/webhooks/stripe", { raw: "{}" })).status).toBe(503);
    expect((await call(bare.url, "POST", "/webhooks/apple", { raw: "{}" })).status).toBe(503);
    await bare.close();
  });
});

describe("RevenueCat", () => {
  const rcBody = (id: string, type: string, tx: string, store = "APP_STORE") => JSON.stringify({ event: { id, type, store, transaction_id: tx, app_user_id: "zed", product_id: "coins_500" } });
  it("requires the shared authorization secret", async () => {
    expect((await post("/webhooks/revenuecat", rcBody("r1", "NON_RENEWING_PURCHASE", "1000"))).status).toBe(401);
    expect((await post("/webhooks/revenuecat", rcBody("r1", "NON_RENEWING_PURCHASE", "1000"), { authorization: "Bearer nope" })).status).toBe(401);
  });
  it("RevenueCat + direct Apple notification for the same store transaction issue coins once", async () => {
    await post("/webhooks/revenuecat", rcBody("r2", "NON_RENEWING_PURCHASE", "2000"), { authorization: `Bearer ${RC}` });
    await post("/webhooks/apple", appleBody({ uuid: "n-1", type: "ONE_TIME_CHARGE", txId: "2000" }));
    await processDue(s.db);
    expect(await bal()).toBe(500n);
    expect((await s.db.query(`SELECT 1 FROM journal_entries WHERE type='purchase'`)).rows).toHaveLength(1);
  });
});

describe("Apple StoreKit 2 notifications (JWS x5c)", () => {
  it("accepts a valid chain, resolves appAccountToken to the user, and credits", async () => {
    expect((await post("/webhooks/apple", appleBody({ uuid: "n-2", type: "ONE_TIME_CHARGE", txId: "3000" }))).status).toBe(200);
    await processDue(s.db);
    expect(await bal()).toBe(500n);
  });
  it("rejects a chain from an untrusted root and tampered payloads", async () => {
    expect((await post("/webhooks/apple", appleBody({ uuid: "n-3", type: "ONE_TIME_CHARGE", txId: "3001", chain: evil }))).status).toBe(401);
    const good = JSON.parse(appleBody({ uuid: "n-4", type: "ONE_TIME_CHARGE", txId: "3002" }));
    const [h, , sig] = good.signedPayload.split(".");
    const forged = `${h}.${b64({ notificationType: "ONE_TIME_CHARGE", notificationUUID: "n-4", data: {} })}.${sig}`;
    expect((await post("/webhooks/apple", JSON.stringify({ signedPayload: forged }))).status).toBe(401);
    expect((await s.db.query(`SELECT 1 FROM webhook_events`)).rows).toHaveLength(0);
  });
  it("ignores Sandbox transactions in production mode", async () => {
    const prod = await startApp({ NODE_ENV: "production", WORKER_DATABASE_URL: "x", PAYOUT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "k", REDIS_URL: "redis://x", JWT_SECRET: SECRET, APPLE_ROOT_CA_PEM: apple.rootPem }, [webhookRoutes()]);
    await call(prod.url, "POST", "/webhooks/apple", { raw: appleBody({ uuid: "n-5", type: "ONE_TIME_CHARGE", txId: "3003", env: "Sandbox" }) });
    expect((await prod.db.query(`SELECT status FROM webhook_events`)).rows[0].status).toBe("ignored");
    await prod.close();
  });
});

describe("Google Play RTDN (OIDC push)", () => {
  const purchase = (id: string) => gBody(id, { oneTimeProductNotification: { notificationType: 1, purchaseToken: "ptok", sku: "coins_500" } });
  it("rejects bad signature, audience, service account, and missing token", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const t of [gTok({}, other.privateKey), gTok({ aud: "evil" }), gTok({ email: "attacker@x.com" }), gTok({ exp: 1 }), gTok({ email_verified: false }), ""])
      expect((await post("/webhooks/google", purchase("m1"), { authorization: `Bearer ${t}` })).status).toBe(401);
  });
  it("without Play API credentials a purchase is parked for review, never credited", async () => {
    expect((await post("/webhooks/google", purchase("m2"), { authorization: `Bearer ${gTok()}` })).status).toBe(200);
    await processDue(s.db);
    expect((await st("google", "m2")).status).toBe("needs_review");
    expect(await bal()).toBe(0n);
  });
  it("with a verifier, credits by Play order id; voided notification reverses", async () => {
    await post("/webhooks/google", purchase("m3"), { authorization: `Bearer ${gTok()}` });
    await processDue(s.db, { playVerifier: verifier });
    expect(await bal()).toBe(500n);
    await post("/webhooks/google", gBody("m4", { voidedPurchaseNotification: { orderId: "GPA.1", productType: 2 } }), { authorization: `Bearer ${gTok()}` });
    await processDue(s.db);
    expect(await bal()).toBe(0n);
    await inv();
  });
});

describe("refunds, chargebacks, ordering and retries", () => {
  const refund = (id: string, pi: string, type = "charge.refunded") => stripeEvent(id, type, { payment_intent: pi });
  const send = (raw: string) => post("/webhooks/stripe", raw, { "stripe-signature": stripeSig(raw) });
  const makeDue = () => s.db.query(`UPDATE webhook_events SET next_attempt_at=now() WHERE status='retrying'`);

  it("out-of-order: refund before purchase retries, then reverses once the purchase lands", async () => {
    await send(refund("evt_r1", "pi_o"));
    await processDue(s.db);
    expect((await st("stripe", "evt_r1")).status).toBe("retrying");
    await send(stripePurchase("evt_p1", "pi_o"));
    await processDue(s.db);
    expect(await bal()).toBe(500n);
    await makeDue(); await processDue(s.db);
    expect(await bal()).toBe(0n);
    expect((await st("stripe", "evt_r1")).status).toBe("processed");
    await inv();
  });
  it("duplicate refund and chargeback for one purchase reverse only once", async () => {
    await send(stripePurchase("evt_p2", "pi_d")); await processDue(s.db);
    await send(refund("evt_r2", "pi_d")); await send(refund("evt_c2", "pi_d", "charge.dispute.created"));
    await processDue(s.db);
    expect(await bal()).toBe(0n);
    expect((await s.db.query(`SELECT 1 FROM journal_entries WHERE type='reversal'`)).rows).toHaveLength(1);
    await inv();
  });
  it("chargeback after coins were spent parks for review and never goes negative", async () => {
    await send(stripePurchase("evt_p3", "pi_s")); await processDue(s.db);
    await L.sendGift(s.db, { giftId: "spend", fromUser: "zed", creatorId: "cr", coins: 400n });
    await send(refund("evt_c3", "pi_s", "charge.dispute.created")); await processDue(s.db);
    expect((await st("stripe", "evt_c3")).status).toBe("needs_review");
    expect(await bal()).toBe(100n);
    await inv();
  });
  it("retries with backoff, records every attempt, then stops for review", async () => {
    await send(refund("evt_never", "pi_none"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) { await makeDue(); await processDue(s.db); }
    const e = await st("stripe", "evt_never");
    expect(e.status).toBe("needs_review"); expect(Number(e.attempts)).toBe(MAX_ATTEMPTS);
    expect((await s.db.query(`SELECT 1 FROM webhook_event_attempts`)).rows).toHaveLength(MAX_ATTEMPTS);
    await expect(s.db.query(`DELETE FROM webhook_event_attempts`)).rejects.toThrow(/append-only/);
    const before = (await processDue(s.db)); expect(before.processed + before.failed).toBe(0); // no longer scheduled
  });
  it("recovers events stuck in 'processing' after a worker crash (expired lease)", async () => {
    await send(stripePurchase("evt_p4", "pi_crash"));
    await s.db.query(`UPDATE webhook_events SET status='processing', attempts=1, locked_until=now() - interval '1 minute'`);
    await processDue(s.db);
    expect(await bal()).toBe(500n);
    // crash AFTER crediting but before marking processed: re-run is a no-op credit
    await s.db.query(`UPDATE webhook_events SET status='processing', locked_until=now() - interval '1 minute'`);
    await processDue(s.db);
    expect(await bal()).toBe(500n);
    await inv();
  });
});

describe("simulation mode", () => {
  const admin = token("root", "admin");
  it("is admin-only, flows through the same pipeline, and is segregated in the ledger", async () => {
    const body = { eventId: "sim1", kind: "purchase", providerTxId: "t1", userId: "zed", sku: "coins_500" };
    expect((await call(s.url, "POST", "/v1/admin/webhooks/simulate", { tok: token("zed"), body })).status).toBe(403);
    expect((await call(s.url, "POST", "/v1/admin/webhooks/simulate", { tok: admin, body })).status).toBe(202);
    await processDue(s.db);
    expect(await bal()).toBe(500n);
    expect((await s.db.query(`SELECT 1 FROM journal_entries WHERE idempotency_key='purchase:simulation:t1'`)).rows).toHaveLength(1);
  });
  it("is 404 when disabled and refused at startup in production", async () => {
    const off = await startApp({}, [webhookRoutes()]);
    expect((await call(off.url, "POST", "/v1/admin/webhooks/simulate", { tok: admin, body: { eventId: "x", kind: "purchase", providerTxId: "t" } })).status).toBe(404);
    await off.close();
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "x", JWT_SECRET: SECRET, WEBHOOK_SIMULATION: "true" })).toThrow(/production/);
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "x", JWT_SECRET: "short" })).toThrow();
  });
});
