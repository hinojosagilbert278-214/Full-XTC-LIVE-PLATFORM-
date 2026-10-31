# Financial integrity report — Phase 5

Evidence: `npm test` → **113 tests, 9 files, all passing** (3 consecutive full runs, local PostgreSQL 16.15 + Redis 7.0.15). `npm audit`: 0 vulnerabilities. `tsc --noEmit` clean.
CI workflow updated (Redis, financial gate) but **has not been executed on GitHub Actions**; it is unverified.

| Property | Evidence (test) | Result |
|---|---|---|
| Every entry balances; global sum 0; cached balances = postings | `inv()` after every payout/clawback scenario; `concurrency.test` | pass |
| No double spend / no double reservation | 8 concurrent 200-coin requests vs 700 available → exactly 3 succeed; 2×700 → 1 succeeds | pass |
| Duplicate requests idempotent | 20 concurrent same-key requests → 1 payout, 1 reserve; changed amount → conflict | pass |
| Never pay twice | 3 concurrent workers × 12 payouts → exactly 12 provider calls/transfers | pass |
| Timeout after provider success | recovered by lookup: 1 transfer, 1 call, funds settled | pass |
| Timeout before provider | retried with same key: 1 transfer | pass |
| Worker dies after provider success | lease expiry → lookup → paid, no second create | pass |
| DB crash-restart mid-payout | `pg-test.sh crash`; reserved funds intact, invariants hold, worker completes | pass |
| Illegal transitions / edits of financial fields | DB trigger rejects even as owner | pass |
| Immutable history | payout_events, policy history, journal/postings append-only | pass |
| Policy not silently approved | payouts blocked in app and DB until approved; policy changes need two distinct admins (migration 007); app role cannot call propose/approve | pass |
| Refund-related hold | refund request auto-holds creator share; released on decision | pass |
| Clawback / debt | refund after payout → earnings 0, debt −600 (receivable), viewer refunded; replay idempotent; offset entry on later earnings | pass |
| Legacy refund path unchanged | plain `reverseEntry` still raises InsufficientFunds | pass |
| Frozen wallet | cannot spend, can receive reversal | pass |
| Reconciliation | clean run ok; provider reversal and missing transfer detected | pass |
| Least privilege / RLS | app role cannot INSERT/UPDATE/DELETE ledger, holds, events; frontend role sees only own rows; startup assertion rejects superuser | pass |
| Redis shared limits | two clients: exactly N of 60 allowed; two API instances: 5 of 14 → 200 | pass |
| Redis outage | degrades to bounded local limit; recovers when Redis returns | pass |
| Stripe client | request shape, idempotency header, error classification vs **local fake** | pass (NOT Stripe verification) |

## Not proven
- Any behaviour against real Stripe, Apple, Google or RevenueCat. All provider tests use synthetic fixtures or fakes.
- Load, HA failover, backup/restore, PITR. Superuser/DBA tampering is not preventable by triggers; needs restricted operator access, off-box backups and independent audit evidence (pgaudit).
- Concurrency across multiple PostgreSQL nodes; behaviour at scale.
- Business correctness of the accounting policies: **still unapproved** (see ACCOUNTING_DECISIONS.md). Tests approve them explicitly with example values (hold 0 days, 1 coin=$0.01) that are NOT recommendations.
