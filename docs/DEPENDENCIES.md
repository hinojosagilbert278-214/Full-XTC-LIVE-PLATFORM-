# Outstanding dependency register

| # | Dependency | Needed for | Owner | Status |
|---|---|---|---|---|
| 1 | Business sign-off on accounting rules 1–8 | Refunds/chargebacks/clawbacks/holds | Finance/Product | **Open** (docs/ACCOUNTING_RULES.md) |
| 2 | Stripe account, webhook signing secret, Connect Express platform setup | Web purchases, payouts | Eng/Finance | Open — webhook verified against synthetic signed payloads only; **payout engine not built** |
| 3 | Apple: App Store Connect, Server Notifications V2 URL, Apple Root CA G3 PEM, `appAccountToken` issuance at purchase | iOS coins | Eng | Open |
| 4 | Google Play: RTDN Pub/Sub topic + push SA, Play Developer API service account, `obfuscatedExternalAccountId` | Android coins | Eng | Open — `PlayVerifier` real implementation missing |
| 5 | RevenueCat project + webhook auth header | Cross-store events | Eng | Open |
| 6 | Identity service issuing JWTs (preferably asymmetric + JWKS) | Authn | Platform | Open |
| 7 | Redis (shared rate limits) | Multi-instance rate limiting | Infra | Code done and tested against local Redis 7; **production Redis (auth/TLS/HA) open** |
| 8 | Managed PostgreSQL 16+, PITR backups, least-privilege roles, HA | Production DB | Infra | Open — backup/restore **not tested** |
| 9 | Secrets manager + rotation | All secrets | Infra | Open |
| 10 | Product catalog (SKU→coins) loaded in `products` | Crediting | Product | Open (tests seed fixtures) |
| 11 | Real-Postgres load testing, pgbouncer sizing, HA failover tests | Scale claims | Eng | Open |
| 12 | Payout engine | Creator payouts | Eng | Built; verified vs simulator and local Stripe fake only. **Needs Stripe test-mode verification, Connect onboarding, `transfer.reversed`/`account.updated` webhooks** |
| 15 | Approval of `accounting_policy` values (hold_days, coin_value_usd_micros, min_payout_coins, review_threshold_coins, clawback_mode, …) | Enabling any payout | Finance | **Open — payouts are blocked until approved** |
| 16 | Provision DB login roles (members of xtc_app / xtc_admin), owner role for migrations | Production DB | Infra | Open |
| 13 | Legal/compliance review (stored value, KYC, tax, 18+, app-store rules) | Launch | Legal | Open |
| 14 | External security review / pen-test | Launch | Security | Open |
