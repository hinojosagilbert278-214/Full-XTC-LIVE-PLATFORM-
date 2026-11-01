# Phase 5 hardening report — remediation, restore drill, load drill

Status: **NOT production-ready. Real payouts remain disabled. All 8 accounting policies remain unapproved.** Stripe is unverified (fake server only). Tests: 139 passing, stable over 3 consecutive full runs; `tsc` clean; `npm audit` 0 vulnerabilities. The GitHub Actions workflow has still never run.

## Remediation of the five SQL findings (migration `007_remediation.sql`)
| # | Finding | Fix | Evidence (`tests/pg/remediation.test.ts`) | Remaining limit |
|---|---|---|---|---|
| 1 | single-admin policy approval | `policy_proposals` + `propose_policy` / `approve_policy_proposal`; proposer≠approver enforced in the function **and** by a table CHECK; `accounting_policy` can only change inside the function; history stores proposer, approver, proposed_at, approved time, version, value; old `approve_policy` dropped | self-approval refused (function and direct table update); history contents; direct UPDATE refused; app role refused; supersede | DB compares actor *strings* supplied by the authenticated app; two admins sharing one login defeat it. No MFA/step-up |
| 2 | `needs_review→paid` without proof | `payout_provider_evidence` (append-only, unique per payout and per provider ref); `payouts_guard` requires matching provider/ref/amount/currency for any →paid, and for `needs_review→paid` evidence source must be `provider_lookup` or `provider_webhook` | owner-level UPDATE refused without / with mismatched / with `create_response` evidence; service path succeeds | DB verifies existence and consistency, **not authenticity**: a privileged writer could insert a fabricated evidence row. Authenticity rests on the provider call |
| 3 | no payout↔ledger relation | `reserve/settle/return/reverse_entry` FKs (set-once, unique) + deferred constraint trigger that checks, at commit, that the entries required by the status exist with the exact accounts and amounts; deferred trigger on `journal_entries` rejects any entry touching `payout:clearing`/`payout:paid` that no payout owns | forged insert, forged status, wrong-entry link, orphan movements (typed or untyped) all refused | legacy payouts created before 007 (none exist in any deployed DB) would fail the check on update |
| 4 | holds covered creator share only | refund trigger holds creator **and family** shares per account; hold lifecycle `active → released \| consumed` (consumed links the reversal entry); append-only `payout_hold_events`; `place_chargeback_holds` (called automatically by the webhook handler on chargeback, before the reversal attempt); `familyAvailability`, `offsetFamilyDebt` (explicit offset entry) | refund consume/release incl. family, chargeback holds and idempotence, family debt + offset | chargeback hold sizing is conservative (unrecovered = purchase coins − current wallet, can over-hold for users with several purchases); slow at scale (see load report); family payouts do not exist yet; no automatic wallet freeze |
| 5 | triggers disable-able | event trigger blocks ALTER/DROP/CREATE of tables, triggers, functions outside `migrate()`; TRUNCATE guard on 13 financial tables; `ddl_audit` (append-only); app roles hold no TRIGGER/TRUNCATE/REFERENCES (tested) | all tested, incl. migration re-run | **Superuser can bypass everything** — see `docs/OPERATIONS.md`. pgaudit, restricted DBA access, off-box backups, external audit evidence are required and unverified. The flags are not a security boundary |

Other changes: the payout worker always looks up the provider transfer before creating (found by the drill design, see below); `PgDb` exposes retry/deadlock counters; `migrate()` sets the migration flag and records `ddl_audit`.

## Drills
- Backup/restore: `docs/DR_DRILL_REPORT.md` — digests identical, guards intact, interrupted-payout recovery and older-backup scenario create no duplicate transfers.
- Load: `docs/LOAD_TEST_REPORT.md` — 8/16/32 workers × 30 s, 0 deadlocks, 0 retries, every end-state invariant held, no duplicate payouts or transfers.

## Failures / defects found
1. Worker could duplicate a transfer after restoring an older backup once provider idempotency keys expire → fixed (always look up first), tested.
2. `place_chargeback_holds` slows sharply under concurrency → **open**, documented.
3. Test harness `TRUNCATE`/`DISABLE TRIGGER` needed explicit flags after the new guards (expected).

## Still outstanding (unchanged by this round)
Policy approval by finance/legal (incl. coin→USD rate; $0.01/coin is test-only); Stripe test-mode verification (onboarding, transfers, reversals, disabled accounts, webhooks, uncertain outcomes); pgaudit and off-box backups; PITR; defined target workload and thresholds before any capacity claim; legal/compliance review; first GitHub Actions run; family payouts; step-up auth for payout-account changes.
