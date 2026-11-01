# Database operations and the residual privileged-operator threat

## What the database now enforces (migration 008)
- Ledger and payout history tables are append-only (row triggers). `TRUNCATE` of protected tables, `ALTER/DROP TABLE|TRIGGER|FUNCTION`, `CREATE [OR REPLACE] FUNCTION/TRIGGER`, `GRANT/REVOKE`, policy DDL and event-trigger changes are refused unless the session login is a **direct member of `xtc_migrator`** (`pg_auth_members`, read for `session_user`). No `SET xtc.*` flag grants anything; the flags are ignored (tested). `migrate()` still sets `xtc.migrating` only so the older 007 definitions replay inside one transaction.
- Runtime logins (`xtc_app`, `xtc_provider_worker`, `xtc_admin`, `xtc_readonly`, `xtc_policy_admin`) are non-superuser, own no objects, and hold no TRIGGER/TRUNCATE/REFERENCES.
- Accounting policy changes only through a two-person proposal made by authenticated, distinct `xtc_policy_admin` logins (see `docs/ADMIN_IDENTITY.md`). There is no HTTP write path.
- `payouts` insert only as `pending_review`/`queued`; `paid` needs matching provider evidence (lookup evidence from `needs_review`) recorded through `record_provider_evidence` by the worker login; each journal entry carries `metadata.payoutId` and key `payout:<id>:<kind>`.
- Chargeback holds only via `place_chargeback_holds(event_id)` for a recorded `chargeback` webhook event; lookback 1..180 days; per-case and per-account caps.

## What it cannot enforce
A **superuser** (or the host OS account, or anyone who can reach the data files/backups) can bypass everything: `SET session_replication_role = replica`, `ALTER ... DISABLE TRIGGER`, drop the event trigger, `SET SESSION AUTHORIZATION`, `GRANT xtc_migrator`, edit evidence, policy rows or history, restore an altered backup. A migrator can legitimately change schema and functions. The database also cannot prove that provider evidence or webhook events are authentic: it enforces consistency and *who recorded it*, not that Stripe said it. Do not describe the ledger as tamper-proof.

## Required production controls (NOT implemented or verified here)
1. Application and migration logins are never superusers; migrations run as a dedicated `xtc_migrator` login (separate credentials, used only by the deploy pipeline), not the cloud superuser and not the runtime connection. Superuser access is break-glass, time-boxed and ticketed.
2. `pgaudit` (or the managed-service equivalent) logging DDL and role changes to an external, write-once sink. *Not installed or tested in this environment.*
3. Off-box, encrypted, access-controlled backups with a tested restore (logical drill: `docs/DR_DRILL_REPORT.md`; PITR/WAL archiving untested).
4. Independent audit evidence: periodic export of a hash chain / signed digest of `journal_entries` to storage the DB operators cannot write.
5. Restore runbook: `pg_restore` of a dump is run by a migrator login (the DDL guard is part of the schema); the flag is no longer required for restore.
6. After any restore, **always** run `reconcilePayouts` before enabling the payout worker. The worker looks up the provider transfer (`transfer_group=payout-<id>`) before ever creating one, because provider idempotency keys expire (~24h for Stripe) and a restored DB may be older than the provider.
