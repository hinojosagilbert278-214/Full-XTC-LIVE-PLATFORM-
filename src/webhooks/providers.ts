import { createHmac, createVerify, verify as cryptoVerify, X509Certificate, createPublicKey, type KeyObject } from "node:crypto";
import { safeEqual } from "../api/auth";

export class WebhookAuthError extends Error {}
export class ProviderNotConfigured extends Error {}

export type Kind = "purchase" | "refund" | "chargeback" | "ignore";
export interface Normalized {
  provider: string;        // delivering channel
  eventId: string;
  kind: Kind;
  ledgerProvider?: "stripe" | "apple" | "google";
  providerTxId?: string;
  userRef?: string;        // user id, or an account token resolved via app_account_tokens
  sku?: string;
  purchaseToken?: string; // Google: resolved to an order via PlayVerifier
}
type Headers = Record<string, string | string[] | undefined>;
const h1 = (h: Headers, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };
const ID = /^[A-Za-z0-9_.:=-]{1,200}$/;
const clean = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined);

// ---------- Stripe ----------
export function verifyStripe(raw: Buffer, headers: Headers, secret: string | undefined, now = Date.now(), toleranceSec = 300): Normalized {
  if (!secret) throw new ProviderNotConfigured("stripe");
  const sig = h1(headers, "stripe-signature") ?? "";
  const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) throw new WebhookAuthError("stale or missing timestamp");
  const expected = createHmac("sha256", secret).update(`${parts.t}.`).update(raw).digest("hex");
  const candidates = sig.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!candidates.some((c) => safeEqual(c, expected))) throw new WebhookAuthError("bad signature");
  const ev = JSON.parse(raw.toString("utf8"));
  const base = { provider: "stripe", eventId: clean(ev.id) ?? "" };
  if (!base.eventId) throw new WebhookAuthError("missing event id");
  const o = ev.data?.object ?? {};
  switch (ev.type) {
    case "checkout.session.completed":
      if (o.payment_status !== "paid") return { ...base, kind: "ignore" };
      return { ...base, kind: "purchase", ledgerProvider: "stripe", providerTxId: clean(o.payment_intent) ?? clean(o.id), userRef: clean(o.metadata?.user_id), sku: clean(o.metadata?.sku) };
    case "charge.refunded":
      return { ...base, kind: "refund", ledgerProvider: "stripe", providerTxId: clean(o.payment_intent) };
    case "charge.dispute.created":
      return { ...base, kind: "chargeback", ledgerProvider: "stripe", providerTxId: clean(o.payment_intent) };
    default: return { ...base, kind: "ignore" };
  }
}

// ---------- RevenueCat ----------
const RC_STORE: Record<string, "stripe" | "apple" | "google"> = { APP_STORE: "apple", MAC_APP_STORE: "apple", PLAY_STORE: "google", STRIPE: "stripe" };
export function verifyRevenueCat(raw: Buffer, headers: Headers, authSecret: string | undefined): Normalized {
  if (!authSecret) throw new ProviderNotConfigured("revenuecat");
  const got = h1(headers, "authorization") ?? "";
  if (!safeEqual(got, authSecret) && !safeEqual(got, `Bearer ${authSecret}`)) throw new WebhookAuthError("bad authorization");
  const ev = JSON.parse(raw.toString("utf8")).event ?? {};
  const base = { provider: "revenuecat", eventId: clean(ev.id) ?? "" };
  if (!base.eventId) throw new WebhookAuthError("missing event id");
  const lp = RC_STORE[ev.store];
  // Keyed by the underlying store transaction so Apple/Google direct notifications and RevenueCat dedupe each other.
  const common = { ledgerProvider: lp, providerTxId: clean(String(ev.transaction_id ?? "")), userRef: clean(ev.app_user_id), sku: clean(ev.product_id) };
  if (!lp) return { ...base, kind: "ignore" };
  if (ev.type === "NON_RENEWING_PURCHASE" || ev.type === "INITIAL_PURCHASE") return { ...base, kind: "purchase", ...common };
  if (ev.type === "REFUND") return { ...base, kind: "refund", ...common };
  return { ...base, kind: "ignore" };
}

// ---------- JWS helpers (Apple) ----------
const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Verifies an Apple-style JWS: ES256 signature by the x5c leaf, chain leaf→intermediate→root, root pinned to a trusted PEM. */
export function verifyJwsX5c(jws: string, trustedRootPem: string, now = Date.now()): any {
  const [h, p, s] = jws.split(".");
  if (!h || !p || !s) throw new WebhookAuthError("malformed jws");
  const header = decode(h);
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 2) throw new WebhookAuthError("bad jws header");
  const chain = header.x5c.map((c: string) => new X509Certificate(Buffer.from(c, "base64")));
  const root = new X509Certificate(trustedRootPem);
  const d = new Date(now);
  for (const c of chain) if (d < new Date(c.validFrom) || d > new Date(c.validTo)) throw new WebhookAuthError("certificate not valid now");
  for (let i = 0; i < chain.length - 1; i++)
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) throw new WebhookAuthError("broken chain");
  const top = chain[chain.length - 1];
  const anchored = top.raw.equals(root.raw) || (top.checkIssued(root) && top.verify(root.publicKey));
  if (!anchored || !root.verify(root.publicKey)) throw new WebhookAuthError("untrusted root");
  const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key: chain[0].publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) throw new WebhookAuthError("bad jws signature");
  return decode(p);
}

// ---------- Apple App Store Server Notifications V2 ----------
export function verifyApple(raw: Buffer, rootPem: string | undefined, o: { production: boolean; now?: number }): Normalized {
  if (!rootPem) throw new ProviderNotConfigured("apple");
  const note = verifyJwsX5c(JSON.parse(raw.toString("utf8")).signedPayload, rootPem, o.now);
  const base = { provider: "apple", eventId: clean(note.notificationUUID) ?? "" };
  if (!base.eventId) throw new WebhookAuthError("missing notification id");
  const tx = note.data?.signedTransactionInfo ? verifyJwsX5c(note.data.signedTransactionInfo, rootPem, o.now) : {};
  // Sandbox purchases must never issue production coins.
  if (o.production && (note.data?.environment !== "Production" || tx.environment !== "Production")) return { ...base, kind: "ignore" };
  const common = { ledgerProvider: "apple" as const, providerTxId: clean(String(tx.transactionId ?? "")), userRef: clean(tx.appAccountToken), sku: clean(tx.productId) };
  if (note.notificationType === "ONE_TIME_CHARGE") return { ...base, kind: "purchase", ...common };
  if (note.notificationType === "REFUND") return { ...base, kind: "refund", ...common };
  return { ...base, kind: "ignore" };
}

// ---------- Google Play RTDN via Pub/Sub push (OIDC) ----------
export type KeyResolver = (kid: string) => Promise<string | undefined>; // PEM by key id
export async function verifyGoogle(raw: Buffer, headers: Headers, o: { audience?: string; serviceAccount?: string; keys: KeyResolver; now?: number }): Promise<Normalized> {
  if (!o.audience || !o.serviceAccount) throw new ProviderNotConfigured("google");
  const tok = (h1(headers, "authorization") ?? "").replace(/^Bearer /, "");
  const [h, p, s] = tok.split(".");
  if (!h || !p || !s) throw new WebhookAuthError("missing oidc token");
  const header = decode(h), claims = decode(p);
  if (header.alg !== "RS256") throw new WebhookAuthError("bad alg");
  const pem = await o.keys(String(header.kid));
  if (!pem) throw new WebhookAuthError("unknown key");
  if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(pem, Buffer.from(s, "base64url"))) throw new WebhookAuthError("bad signature");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss) || claims.aud !== o.audience || claims.email !== o.serviceAccount || claims.email_verified !== true || claims.exp <= now)
    throw new WebhookAuthError("bad claims");
  const env = JSON.parse(raw.toString("utf8"));
  const eventId = clean(env.message?.messageId);
  if (!eventId) throw new WebhookAuthError("missing message id");
  const n = JSON.parse(Buffer.from(env.message.data ?? "", "base64").toString("utf8"));
  const base = { provider: "google", eventId };
  if (n.oneTimeProductNotification?.notificationType === 1)
    // Purchase details (order id, user, state) must come from the Play Developer API at processing time.
    return { ...base, kind: "purchase", ledgerProvider: "google", sku: clean(n.oneTimeProductNotification.sku), purchaseToken: clean(n.oneTimeProductNotification.purchaseToken) };
  if (n.voidedPurchaseNotification) return { ...base, kind: "refund", ledgerProvider: "google", providerTxId: clean(n.voidedPurchaseNotification.orderId) };
  return { ...base, kind: "ignore" };
}

/** Google verification of a purchase token needs Play Developer API credentials (not available): boundary + simulation only. */
export interface PlayVerifier { verify(purchaseToken: string, sku: string): Promise<{ orderId: string; userRef: string }> }
export const publicKeyFromPem = (pem: string): KeyObject => createPublicKey(pem);
