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

- Tests run on PGlite (Postgres in WASM, **single connection**). The "double spend" test proves the
  CHECK constraint and serialization semantics, **not** true multi-connection row-lock contention.
  A multi-connection test against real PostgreSQL is required before production.
- Rounding rule: platform absorbs the remainder (`coins − floor(0.7·coins)`); family = floor of its bps of the creator share. This is an
  assumption; confirm against the established economic rules.
- Reversal fails (rather than going negative) if creator funds were already paid out; this needs an
  approved negative-balance/clawback accounting rule and a manual-review queue.
- No HTTP API, auth, RLS, webhooks signature verification, or provider adapters yet.

## 4. Acceptance table

| Area | Status | Evidence | Remaining work |
|---|---|---|---|
| Architecture | Draft | `docs/ARCHITECTURE.md` | Diagrams, capacity/cost models need real load data |
| Backend | Not started (ledger core only) | `src/ledger` | API, auth, RLS, rate limiting |
| Frontend | Not started | – | Web + iOS/Android clients, design system |
| Wallet | Core implemented | 14 passing tests | Multi-connection tests on Postgres, provider webhooks, reconciliation jobs |
| Payouts | Not started | – | Stripe Connect Express adapter, payout state machine, idempotent execution (needs Stripe credentials) |
| Broadcasting | Not started | – | SFU/WHIP/LL-HLS (needs infra vendor decision) |
| Gaming | Not started | – | Signed sessions, server-authoritative scoring |
| Families | Not started | split rule only | Membership, cooldown, invite, transfer rules (need existing rule specs) |
| World Dominion | Not started | – | Territory model, tile-aggregation pipeline |
| AI | Not started | – | Orchestrator, RAG, tool-permission layer |
| Security | Minimal | DB-level integrity only | Threat model, authn/z, scanning, compliance review (legal) |
| CI/CD | Baseline | `.github/workflows/ci.yml` | Security scans, SBOM, signing, load tests, deploy verification |
| Production deployment | Not started | – | Infra, credentials, runbooks, DR tests |
