# Administrator and privileged database identities

Four-eyes and evidence controls are only as strong as the separation of these identities. The database trusts `session_user`
(the authenticated login; unchanged by `SET ROLE`, changeable only by a superuser), never a caller-supplied name.

| Identity | Purpose | Can | Must never |
|---|---|---|---|
| `xtc_app` login | API runtime | ledger/wallet/payout request SQL | propose/approve policy, write evidence, place holds directly, DDL |
| `xtc_provider_worker` login (`WORKER_DATABASE_URL`) | payout worker + provider lookup | `record_provider_evidence`, move payouts | be shared with the API pool or any human |
| `xtc_policy_admin` personal logins | accounting-policy proposals/approvals | `propose_policy`, `approve_policy_proposal`, `reject_policy_proposal`, read policy | be a member of `xtc_app`/`xtc_admin`; share a login; be used by an application |
| `xtc_admin` | operational admin API (reviews, holds, freezes) | operational writes | change policy |
| `xtc_migrator` login | deploy pipeline only | DDL, `TRUNCATE`, trigger/grant changes | be used at runtime; be reachable from the app network |
| superuser | break-glass | everything | day-to-day use |

## Provisioning
1. One personal login per policy administrator: `CREATE ROLE jane LOGIN PASSWORD NULL; GRANT xtc_policy_admin TO jane;` authenticated by the
   enterprise IdP (SCRAM + client certificate or IAM/OIDC token auth). **Direct** membership is required (the check reads `pg_auth_members`);
   a login that merely inherits the role through another role is not accepted.
2. The approver set must contain at least two people. A single person holding two logins defeats the control; this is organisational and
   cannot be checked by the database. Quarterly access review should compare logins to named individuals.
3. Network: policy-admin and migrator logins connect from an admin network / bastion only (`pg_hba.conf`); the API and worker hosts cannot use them.
4. The application connection strings (`DATABASE_URL`, `WORKER_DATABASE_URL`) never contain these credentials. `npm run policy` reads `POLICY_DATABASE_URL` from the administrator's own shell/secret manager.

## Authentication
SCRAM-SHA-256 at minimum; prefer short-lived tokens from the secret manager. Shared or service-account logins are prohibited for `xtc_policy_admin`.

## Revocation
`REVOKE xtc_policy_admin FROM jane; ALTER ROLE jane NOLOGIN;` then terminate her sessions (`pg_terminate_backend`). Past approvals remain
in `accounting_policy_history` (the login name is stored as text, so dropping the role does not erase evidence). Record the revocation ticket.

## Audit
- Every proposal/approval stores `proposed_by`/`decided_by` = `session_user`, timestamps, policy version and value (`policy_proposals`, `accounting_policy_history`; both append-only by trigger).
- `audit_log` records admin API actions; `ddl_audit` records migrations.
- Production must additionally ship `pgaudit` (role, ddl, write on policy/evidence tables) to an external write-once sink and alert on any `GRANT`, role membership change, `session_replication_role` use, or migrator login outside a deploy window. *pgaudit is not installed or tested in this repository.*

## Operating the policy CLI
```
POLICY_DATABASE_URL=postgres://jane@db/xtc npm run policy -- propose hold_days 7   # jane
POLICY_DATABASE_URL=postgres://omar@db/xtc npm run policy -- approve 12            # a different person
```

## What a superuser can still do
Anything: change `session_user`, create or join roles, disable triggers (`ALTER TABLE ... DISABLE TRIGGER`, `session_replication_role=replica`), drop the
event trigger, rewrite or delete evidence/policy/ledger rows, restore a doctored backup. Mitigation is organisational: no standing superuser access,
break-glass with approval, external audit sink, off-box backups, and periodic external digests of the ledger.
