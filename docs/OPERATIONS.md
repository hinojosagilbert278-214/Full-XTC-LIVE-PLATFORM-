# Database operations and the residual privileged-operator threat

## What the database now enforces (even against the table owner)
- Ledger and payout history tables are append-only (row triggers); `TRUNCATE` is blocked unless `xtc.allow_destructive='on'`.
- `ALTER TABLE`, `DROP TABLE/TRIGGER/FUNCTION`, `CREATE [OR REPLACE] FUNCTION/TRIGGER` are blocked by an event trigger unless `xtc.migrating='on'`; `migrate()` sets that flag per transaction and writes an append-only `ddl_audit` row.
- App roles (`xtc_app`, `xtc_admin`, `xtc_readonly`) hold no `TRIGGER`, `TRUNCATE` or `REFERENCES` privileges and do not own any object (tested).
- `payouts` cannot reach `paid` without matching provider evidence, nor commit without the exact ledger entries its status implies (deferred constraint triggers).

## What it cannot enforce
A **superuser** (or anyone who can `SET session_replication_role = replica`, drop the event trigger, alter the flags, or edit files on the DB host) can bypass every trigger and rewrite history. The flags above are *speed bumps and audit points*, not security boundaries: any session may set `xtc.migrating`. Do not describe the ledger as tamper-proof.

## Required production controls (NOT implemented or verified here)
1. Application and migration logins are never superusers; migrations run as a dedicated owner role, not the cloud superuser. Superuser access is break-glass, time-boxed and ticketed.
2. `pgaudit` (or the managed-service equivalent) logging DDL and role changes to an external, write-once sink. *Not installed or tested in this environment.*
3. Off-box, encrypted, access-controlled backups with a tested restore (logical drill: `docs/DR_DRILL_REPORT.md`; PITR/WAL archiving untested).
4. Independent audit evidence: periodic export of a hash chain / signed digest of `journal_entries` to storage the DB operators cannot write.
5. Restore runbook: `pg_restore` of a dump needs `PGOPTIONS="-c xtc.migrating=on"` because the DDL guard is part of the schema.
6. After any restore, **always** run `reconcilePayouts` before enabling the payout worker. The worker looks up the provider transfer (`transfer_group=payout-<id>`) before ever creating one, because provider idempotency keys expire (~24h for Stripe) and a restored DB may be older than the provider.
