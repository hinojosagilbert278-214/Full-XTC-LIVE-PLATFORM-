# Engineering Audit & Acceptance Report (Phase 1–3 baseline)

Audit date: 2026-10-31. Scope: this repository only (`Full-XTC-LIVE-PLATFORM-`).

## 1. Audit finding

The repository contained **one commit with only README/LICENSE/.gitignore**. No code, schemas,
migrations, endpoints, workflows or tests existed. Nothing listed in the brief (Pulse Live/Play,
Trust Blue Wallet, Stripe Connect, StoreKit 2, Play Billing, RevenueCat, Families, Reels publishing,
CI Payout Monitor) was present. If those exist in other repositories they have **not** been audited
and must be imported or reviewed before this code is treated as canonical (to protect existing financial data).

## 2. Built so far (verified by `npm test`: 14/14 passing, `npm run typecheck` clean)

| Item | Status |
|---|---|
| `migrations/001_ledger.sql` double-entry ledger | Implemented; re-applicable (tested) |
| Integer (bigint) coin accounting | Implemented |
| Entries must balance (deferred DB constraint trigger) | Implemented, tested |
| Append-only postings/entries (triggers) | Implemented, tested |
| No negative balances (CHECK; only issuance contra-account may go negative) | Implemented, tested |
| Idempotent posting / webhook replay; payload-mismatch rejection | Implemented, tested |
| 70/30 split, family 0–10% of creator share, family recorded as separate posting | Implemented, tested (property-style loop) |
| Refund/chargeback as exact reversal, at most once per entry | Implemented, tested |
| Reconciliation view (`ledger_discrepancies`) + global-sum invariant | Implemented, tested |

## 3. Honest limitations

- (Resolved in Phase 4) PGlite tests are single-connection; real multi-connection locking is now tested on PostgreSQL 16 (docs/CONCURRENCY_REPORT.md).
- Rounding rule: platform absorbs the remainder (`coins − floor(0.7·coins)`); family = floor of its bps of the creator share. This is an
  assumption; confirm against the established economic rules.
- Reversal fails (rather than going negative) if creator funds were already paid out; this needs an
  approved negative-balance/clawback accounting rule and a manual-review queue.
- Phase 4 added HTTP API, JWT auth, webhook verification; RLS and real provider payout adapters remain (docs/SECURITY.md).

## 4. Acceptance table

| Area | Status | Evidence | Remaining work |
|---|---|---|---|
| Architecture | Draft | `docs/ARCHITECTURE.md` | Diagrams, capacity/cost models need real load data |
| Backend | Wallet service only | `src/api`, `src/webhooks`, docs/API.md | Other domains; RLS; Redis rate limits |
| Frontend | Not started | – | Web + iOS/Android clients, design system |
| Wallet | Core + API + webhooks; **not production-ready** | 65 passing tests incl. real PostgreSQL 16 concurrency/crash tests (docs/CONCURRENCY_REPORT.md) | Accounting-rule sign-off, least-privilege DB role, live-provider verification, load tests, pen-test (docs/DEPENDENCIES.md) |
| Payouts | Not started | – | Stripe Connect Express adapter, payout state machine, idempotent execution (needs Stripe credentials) |
| Broadcasting | Not started | – | SFU/WHIP/LL-HLS (needs infra vendor decision) |
| Gaming | Not started | – | Signed sessions, server-authoritative scoring |
| Families | Not started | split rule only | Membership, cooldown, invite, transfer rules (need existing rule specs) |
| World Dominion | Not started | – | Territory model, tile-aggregation pipeline |
| AI | Not started | – | Orchestrator, RAG, tool-permission layer |
| Security | Wallet-service controls tested | docs/SECURITY.md | Threat model, authn/z, scanning, compliance review (legal) |
| CI/CD | Baseline | `.github/workflows/ci.yml` | Security scans, SBOM, signing, load tests, deploy verification |
| Production deployment | Not started | – | Infra, credentials, runbooks, DR tests |
