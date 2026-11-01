# Concurrency & failure test report (real PostgreSQL 16.15)

Environment: PostgreSQL 16.15 (Ubuntu), local cluster via `scripts/pg-test.sh`, `fsync=on`, default READ COMMITTED.
Reproduce: `npm run pg:start && npm run test:pg`. Last local result: **4 files / 65 tests passed, 3 consecutive runs** (includes the 14 PGlite tests).
These are correctness tests on a single local server, **not load tests**; no throughput/latency claims are made.

| Property | Test (tests/pg/concurrency.test.ts unless noted) | Result |
|---|---|---|
| Duplicate webhook/purchase | 20 concurrent identical purchases → 1 credit | pass |
| Concurrent purchases | 50 distinct concurrent credits sum exactly | pass |
| Duplicate gifts | 20 concurrent identical gift ids → 1 debit | pass |
| **No double spending** | 30 simultaneous 100-coin gifts from 1000 coins → exactly 10 succeed, 20 `InsufficientFunds`, balance 0 | pass |
| Same over HTTP | 20 simultaneous gifts from 300 coins → 3×201, 17×409 (api.test.ts) | pass |
| Many-to-one consistency | 10 wallets × 5 gifts to one creator | pass |
| Concurrent refunds | 10 refund keys for one entry → 1 reversal (`reverses_entry` UNIQUE) | pass |
| Row-level locking | Spender B observed blocked (`pg_stat_activity` Lock wait) while A holds the wallet row, then fails on the re-checked balance | pass |
| Isolation | Uncommitted writes invisible to other connection | pass |
| Deadlock + retry | Opposite lock order → Postgres 40P01 victim; adapter retries; both commit | pass |
| Rollback | Insufficient-funds gift leaves no journal row, key reusable; unbalanced entry rolled back at commit | pass |
| Migration reapply | 3 concurrent + sequential re-runs, data preserved (advisory lock) | pass |
| Crash recovery | `pg_ctl restart -m immediate`: committed data intact, in-flight tx discarded, idempotent replay works | pass |
| Worker races | 3 parallel `processDue` → one credit (SKIP LOCKED) ; expired lease re-claimed (webhooks.test.ts) | pass |

How double-spend is prevented: each posting `UPDATE ledger_accounts SET balance = balance + x` takes the row lock; the `CHECK (allow_negative OR balance >= 0)` is
evaluated against the post-lock value, so a concurrent spender waits and then fails. Postings are inserted in sorted account order to avoid lock-order deadlocks.

Not covered (see DEPENDENCIES.md): multi-node/HA failover, replication lag, SERIALIZABLE-mode behaviour, sustained load, disk-full/partial-write faults, pgbouncer.
