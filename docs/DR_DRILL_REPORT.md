# Backup / restore drill (local, real PostgreSQL 16.15)

Test: `tests/dr/restore.test.ts` (runs in CI). Method: `pg_dump -Fc` (single snapshot) → `pg_restore` into a new database on the same cluster.

| Check | Result |
|---|---|
| Per-table digest (count + md5 of rows) of ledger_accounts, journal_entries, postings, payouts, payout_events, payout_holds, hold events, provider evidence, payout_profiles, accounting_policy (+history), policy_proposals, audit_log, refund_requests, webhook_events, ddl_audit: source vs restored | identical (quiesced dump) |
| Global ledger sum = 0, no `ledger_discrepancies` after restore | pass |
| Payout states preserved (paid / processing-after-lost-response / queued) | pass |
| Policy approvals preserved with both actors (proposer, approver) and version | pass |
| Guards intact after restore (append-only, TRUNCATE block, "paid needs evidence", app role can't edit balances) | pass |
| Idempotency: replay of a purchase and of a payout request on the restored DB are no-ops | pass |
| Interrupted payout (provider succeeded, response lost) recovered on restored DB: provider holds 3 transfers for 3 payouts, create calls needed = 1 (only the never-attempted payout) | pass |
| **Backup older than provider state** (payout queued in backup, paid at provider afterwards): worker adopts the existing transfer; create calls and transfer count unchanged | pass |
| Dump taken while 4 workers ran gifts/payout requests/processing: restored snapshot has sum 0, no discrepancies; recovery run creates no duplicate transfers per payout; reconciliation ok | pass |
| Timings (tiny data set, 111 KB dump): dump 60 ms, restore 225 ms | not representative of production volume |

## Defect found and fixed during the drill design
The worker only looked up the provider transfer on retries. A DB restored from a backup older than the provider's state would have created a second transfer once Stripe's idempotency key (≈24 h) expired. The worker now **always** looks up before creating.

## Not covered
PITR / WAL archiving, off-box storage, backup encryption, cross-cluster restore (roles are cluster objects; use `pg_dumpall --roles-only`), restore timing at production size, a real provider (the "provider" is `SimulatedProvider`; the real Stripe lookup path is unverified).
