# Local load / concurrency report (Phase 5 hardening)

`npm run load -- --seconds 30 --workers N` (script: `scripts/load-test.ts`; raw JSON: `reports/load-w*.json`). Real PostgreSQL 16.15 on the same machine as the load generator, `SimulatedProvider`, 20 creators in 4 families, `xtc_app` role, pool = 3×workers.

Mix per worker (round-robin): 40% gifts (with family share), 20% payout requests (half reuse a duplicate idempotency key; simultaneous for the same creator), 20% `processDuePayouts` (all workers claim from the same queue), 10% refund via `reverseWithClawback` (at most 20 distinct seed gifts, so only ~20 refunds happened per run; while payouts are in flight), 10% `place_chargeback_holds`.

| Workers | ops/s | gift p50/p99 ms | payout req p50/p99 ms | chargeback-holds p50/p99 ms | PG deadlocks | tx retries | max lock waiters | paid | reconcile ms | end-state invariants |
|---|---|---|---|---|---|---|---|---|---|---|
| 8 | 148.5 | 1.68 / 17.52 | 4.74 / 28.57 | 369.69 / 788.65 | 0 | 0 | 7 | 550 | 10 | pass |
| 16 | 144 | 1.73 / 43.1 | 4.88 / 51.03 | 808.23 / 1677.35 | 0 | 0 | 15 | 520 | 11.5 | pass |
| 32 | 141.9 | 1.99 / 134.47 | 5.03 / 116.4 | 1698.35 / 3166.1 | 0 | 0 | 31 | 600 | 20.5 | pass |

End-state checks after every run (all passed): global ledger sum 0; no unbalanced entries; no ledger discrepancies; no unexpected negative balances; no duplicate payout idempotency keys; no payout with >1 provider evidence; provider create calls == transfers == paid payouts; clearing/paid account balances match payouts; reconciliation clean.

## Findings
1. **No deadlocks and no serialization retries** in any run; the per-user advisory lock plus SKIP LOCKED claiming serialise conflicts without lock-order cycles. Lock waiters scale with workers (max ≈ workers), i.e. contention is real but resolved by queuing.
2. **`place_chargeback_holds` is the bottleneck** (p50 grows 220 ms → 1.7 s with workers; it scans the user's gift history on every call and dominated the 10% of operations that used it). Production calls it once per chargeback event, not 10% of traffic, but it needs an index/bounded scan before any heavy-chargeback scenario. Not optimised yet.
3. Throughput is flat (~140–250 ops/s) across worker counts mostly because of finding 2 and the single hot "whale" wallet used as every gift's source (all gifts serialise on that one row). This synthetic mix is not representative of real traffic.
4. `payout_request:insufficient_available` rejections are expected business outcomes (chargeback holds and reservations consume availability) and are not failures; they are counted in "rolled back" in the JSON.
5. Reconciliation time is 8–21 ms for ~500–600 payouts (SimulatedProvider; a real provider lookup per payout would dominate).

## What this does NOT show
No target workload or acceptance thresholds (TPS, p99, payout volume, user count) have been defined, so **nothing here demonstrates production capacity**. Client and database share one machine; no network latency, no replicas, no real provider, no pgbouncer, no sustained (hours) or soak run, a single hot wallet instead of realistic distributions.
