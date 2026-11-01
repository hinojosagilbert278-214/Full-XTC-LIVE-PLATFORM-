-- API layer: catalog, families boundary, audit log, refund workflow. Idempotent.

-- Server-side catalog: coin amounts are NEVER taken from client or webhook payloads.
CREATE TABLE IF NOT EXISTS products (
  sku    text PRIMARY KEY,
  coins  bigint NOT NULL CHECK (coins > 0),
  active boolean NOT NULL DEFAULT true
);

-- Minimal Families boundary needed for revenue share. Full membership rules
-- (cooldowns, transfers, invites) are out of scope for the wallet service.
CREATE TABLE IF NOT EXISTS families (
  id        text PRIMARY KEY,
  share_bps integer NOT NULL DEFAULT 0 CHECK (share_bps BETWEEN 0 AND 1000)
);
CREATE TABLE IF NOT EXISTS family_memberships (
  user_id   text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(id),
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('member','co_leader','leader'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text,
  action   text NOT NULL,
  resource text,
  outcome  text NOT NULL,
  ip       text,
  detail   jsonb NOT NULL DEFAULT '{}'
);
DROP TRIGGER IF EXISTS audit_immutable ON audit_log;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE IF NOT EXISTS refund_requests (
  id              bigserial PRIMARY KEY,
  entry_id        bigint NOT NULL REFERENCES journal_entries(id),
  requested_by    text NOT NULL,
  idempotency_key text NOT NULL,
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','rejected','needs_review')),
  decided_by      text,
  reversal_entry  bigint REFERENCES journal_entries(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  UNIQUE (requested_by, idempotency_key)
);
-- At most one open or completed refund per entry.
CREATE UNIQUE INDEX IF NOT EXISTS refund_one_active ON refund_requests(entry_id)
  WHERE status IN ('pending','completed','needs_review');
CREATE INDEX IF NOT EXISTS accounts_owner_idx ON ledger_accounts(owner_id);
