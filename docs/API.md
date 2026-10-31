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
