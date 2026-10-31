# Security assessment — wallet service (Phase 4)

Scope: this service only. Not a penetration test; no external review has occurred.

## Implemented controls (each covered by an automated test unless noted)
| Control | Implementation |
|---|---|
| Authentication | HS256 JWT, pinned alg (rejects `none`/forged/expired/wrong iss/aud) — `auth.ts`, api.test |
| Authorization | Role gates (user/admin/service) + resource checks: own wallet/history/transactions only (404 on foreign), refunds only by payer, family earnings only leaders/admin |
| No client balance control | No endpoint accepts balances or coin amounts for credits; catalog SKU → coins server-side; family share server-side; strict schemas reject extras |
| Validation | zod strict bodies, id regex (prevents account-id injection), integer coin bounds, body size caps (413), content-type (415) |
| Idempotency | Required key on mutations; user-scoped; payload-mismatch → 409 |
| Rate limiting | Per-IP, per-subject and stricter per-subject mutation buckets (in-memory; single node only) |
| Webhook security | Stripe HMAC + 5-min tolerance; RevenueCat constant-time secret; Apple JWS x5c chain pinned to configured root, sandbox ignored in prod; Google OIDC RS256 (aud, SA email, verified, exp). Uniform 401, rejected attempts audited; persisted + deduped by (provider,event_id) |
| Replay protection | Event-id uniqueness + store-transaction keys + Stripe timestamp window |
| Audit logging | Append-only `audit_log` for gifts, refunds, credits, auth/authz failures, rejected webhooks; no tokens/secrets logged |
| Secrets | Env-only config validated at startup (JWT secret ≥32); `.env` git-ignored; `.env.example` has no values; simulation refused in production |
| Ledger integrity | DB-enforced: balanced entries, append-only, non-negative, reversal-once |
| Error handling | Generic 500; no stack/SQL leakage; security headers (`nosniff`, HSTS, `no-store`); CORS allowlist default-deny |
| Dependencies | `npm audit` 0 vulnerabilities at time of writing (CI enforces high+) |

## Known gaps / risks (honest list)
1. **Service DB role** — *Mitigated in Phase 5* (migrations 004/006): runtime role `xtc_app` has no write on ledger tables (writes via SECURITY DEFINER `ledger_post_entry`), no UPDATE on balances; production startup refuses superuser/BYPASSRLS or over-privileged roles. Residual: real login roles/passwords must be provisioned out-of-band (NOLOGIN roles are created by migration); tests use `SET ROLE`.
2. **Triggers don't stop a superuser/owner** from disabling them; need separate migration role + DB audit (pgaudit) + off-box backups.
3. *Closed in Phase 5*: balance updates only via the SECURITY DEFINER trigger; app role has no UPDATE on balances (tested).
4. *Phase 5*: Redis shared limiter implemented and tested (degrades to per-instance local limit on outage). Still needed: Redis auth/TLS/HA. X-Forwarded-For is deliberately **not** trusted; behind a proxy, configure trusted-proxy handling.
5. JWT HS256 shared secret: prefer asymmetric (RS/ES) keys + JWKS + rotation (`kid`) before production; no revocation list.
6. Webhook raw bodies (may contain PII) stored indefinitely; need retention/redaction policy.
7. *Phase 5*: RLS on ledger tables for the `xtc_authenticated` frontend role (own rows, SELECT only; tested). Other tables are simply not granted to it. **Never expose service-role keys to frontends.**
8. Apple/Google/Stripe adapters verified against locally generated fixtures that follow the documented formats, **not** against live provider traffic. Google purchase verification (Play Developer API) is not implemented — such events park in `needs_review`.
9. Purchase price/currency vs catalog not cross-checked; no user-existence check (no identity service in repo); no KYC/age gating; PCI scope not assessed (card data must stay with Stripe-hosted fields).
10. No fraud scoring, velocity limits on gifting beyond rate limiting, or account-takeover protections.
11. Legal/compliance review (money transmission/stored value, tax, app-store virtual currency rules) is outstanding.
12. *Phase 5 additions / residual:* superuser/owner can still disable triggers (needs restricted DBA access, pgaudit, off-box backups). Payout destination re-linking has no cooling-off or step-up auth. Admin actions are audited but there is no four-eyes approval. Payout approval uses app-level admin role from the JWT; policy approval/holds/freeze use a separate `xtc_admin` DB login.
