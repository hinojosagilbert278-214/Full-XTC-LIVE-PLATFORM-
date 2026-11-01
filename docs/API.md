# Wallet API (v1)

Auth: `Authorization: Bearer <JWT>` (HS256, `iss`=JWT_ISSUER, `aud`=JWT_AUDIENCE, `exp` required; claim `role` ∈ user|admin|service).
The JWT is minted by the identity service, never by this one. All mutating `POST`s require `Idempotency-Key` (1–64 chars `A-Za-z0-9_-`), scoped per user.
Amounts are integer coins serialized as **strings**. Errors: `{error, message?}`. Bodies are strict JSON (unknown fields → 422), max 16 KB.

| Method & path | Role | Purpose |
|---|---|---|
| GET `/healthz` | none | Liveness + DB check |
| GET `/v1/wallet` | user | Own balance |
| GET `/v1/wallet/transactions?limit&before` | user | Own postings, keyset-paginated |
| GET `/v1/transactions/:id` | user | Status (`completed`/`reversed`) + own postings; others' entries → 404 |
| GET `/v1/gifts/quote?coins&creatorId` | user | Server-computed split incl. family share disclosure |
| POST `/v1/gifts` `{creatorId, coins}` | user | Send gift. 201 new / 200 replay / 409 `insufficient_funds` or `idempotency_conflict`. Family share is looked up server-side, never accepted from client |
| GET `/v1/creators/me/earnings` | user | Earnings balance (pending/available split undecided, see ACCOUNTING_RULES) |
| GET `/v1/families/:id/earnings` | leader/co-leader/admin | Family earnings balance |
| POST `/v1/refunds` `{entryId, reason}` | user (payer) | Request refund of own gift → 202 `pending` |
| GET `/v1/refunds/:id` | requester | Status |
| POST `/v1/admin/refunds/:id/decision` `{approve}` | admin | Approve (exact reversal, once) or reject; spent funds → 409 `needs_manual_review` |
| POST `/v1/admin/purchases` | service/admin | Manual credit by catalog SKU (reconciliation fixes) |
| GET `/v1/admin/reconciliation` | admin | Invariants, liabilities by account kind, refund/webhook status counts |
| POST `/v1/admin/webhooks/simulate` | admin | **Simulation only** (404 unless `WEBHOOK_SIMULATION=true`; refused in production) |
| POST `/webhooks/{stripe,apple,google,revenuecat}` | signature | Provider webhooks: verify → persist → 200; processed asynchronously |

There is deliberately **no endpoint that lets a client set or adjust a balance** or choose a coin amount.

## Webhook processing
`pending → processing → processed | retrying → … → needs_review | dead`; `ignored` for irrelevant types.
Backoff `30s·2^(n-1)` capped at 1h, max 8 attempts; every attempt is recorded in append-only `webhook_event_attempts`.
Crashed workers: leases (120 s) expire and events are re-claimed; crediting is idempotent so reprocessing is safe.
Purchases are keyed by the underlying store transaction (`purchase:{apple|google|stripe}:{txId}`) so RevenueCat and direct notifications dedupe.


## Payouts (Phase 5)
All routes require a bearer token. Financial mutations require `Idempotency-Key`. Responses use the same error format as the wallet API.

| Method & path | Auth | Purpose |
|---|---|---|
| GET `/v1/payouts/availability` | user | balance / pending / held / debt / reserved / available |
| PUT `/v1/payouts/profile` `{providerAccountId}` | user | link payout account (resets verification) |
| POST `/v1/payouts/profile/sync` | user | refresh verification from the provider |
| POST `/v1/payouts` `{coins}` | user | request payout (202 new / 200 replay; 503 `policy_not_approved`; 409 `no_payout_account`, `account_not_verified`, `below_minimum`, `insufficient_available`) |
| GET `/v1/payouts`, GET `/v1/payouts/:id` | user | own payouts with status history |
| POST `/v1/payouts/:id/cancel` | user | cancel before processing (funds returned) |
| POST `/v1/admin/payouts/:id/review` `{decision}` | admin | approve / reject |
| POST `/v1/admin/payouts/:id/resolve` `{action}` | admin | needs_review → retry / fail / mark_paid (provider proof required) |
| POST `/v1/admin/payouts/:id/reverse` `{reason}` | admin | record provider reversal |
| POST `/v1/admin/holds`, `/v1/admin/holds/:id/release` | admin | admin/risk/chargeback holds |
| POST `/v1/admin/refunds/:id/clawback` | admin | complete refund booking shortfall as debt (needs `clawback_mode=debt`) |
| POST `/v1/admin/accounts/:user/freeze` `{frozen}` | admin | freeze/unfreeze wallet spending |
| GET `/v1/admin/payouts/reconciliation` | admin | ledger + provider reconciliation |
| GET `/v1/admin/policy` | admin | view approved policy values |
| *(removed in 008)* policy propose / approve / reject | – | Policy writes are **not** available over HTTP: the app connection must never be able to act as an administrator. Use `npm run policy -- propose|approve|reject` with a personal `xtc_policy_admin` login (`docs/ADMIN_IDENTITY.md`). These routes now return 404. |
