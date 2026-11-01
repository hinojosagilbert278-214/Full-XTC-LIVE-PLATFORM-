# XTC Architecture (v0.1 draft)

## Decision: modular monolith + specialised media plane

| Concern | Choice | Reasoning / trade-off |
|---|---|---|
| Core API (identity, wallet, families, play, creator) | One TypeScript modular monolith, PostgreSQL | Wallet, families and rewards need strong transactional consistency; splitting them adds distributed-transaction risk for no current scale gain. Cost: single deploy unit; enforce module boundaries (no cross-module table access). |
| Ledger | Module inside the monolith, same Postgres, append-only tables | Atomic with business writes (gift + chat event outbox). Revisit partitioning at high write volume. |
| Real-time | Separate WebSocket gateway + Redis pub/sub | Connection-heavy, stateless-ish, scales independently. |
| Media | Managed/self-hosted SFU (LiveKit-class) for ≤9 interactive; LL-HLS via packager + multi-CDN for viewers | Different scaling profile and failure domain. Vendor choice and costs are open decisions; no figures are claimed here. |
| Async work | Postgres outbox → job queue workers (payouts, publishing, video, AI) | Outbox guarantees no lost events; workers are idempotent. |
| World map | Event stream → in-memory/Redis tile aggregates → periodic snapshots to Postgres; vector tiles to clients | Avoids per-action DB writes on hot map state. Influence counts only verified, active, 18+ members (anti-sybil). |
| Payouts | Stripe Connect Express; state machine pending→available→processing→paid/failed/reversed; idempotency key per payout | Payout "instant" is never promised; settlement/risk checks can delay. |
| AI | Orchestrator with model router, RAG, read-only tools by default; privileged actions create a human-approved, audited request | AI never writes balances or triggers payouts directly. |

## Ledger data flow

```
purchase webhook (verified signature) ─► creditPurchase (key = provider tx id)
viewer ─► sendGift ─► [wallet −N | creator +70%·(1−fam) | family +fam | platform +30%+rem]  (one atomic entry)
refund/chargeback ─► reverseEntry (exact mirror, once)
payout worker ─► payout_clearing posting + Stripe call keyed by payout id
reconciler ─► ledger_discrepancies, provider-vs-ledger diff, creator liabilities
```

## SLO targets (targets, **not measured**)
API p95 < 300 ms; wallet write p95 < 200 ms; ledger discrepancies = 0; interactive latency < 500 ms;
LL-HLS 2–5 s; payout success ≥ 99.5% excluding provider rejections. Capacity/cost models require
load tests and vendor quotes and are deliberately not fabricated here.

## Compliance flags requiring specialist review
Stored-value/money-transmission, KYC/tax reporting, PCI scope (use hosted payment fields), COPPA/age
gating (18+ verification), App Store/Play virtual-currency and gifting rules, privacy law (GDPR/CCPA).
