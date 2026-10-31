-- Accounting policy gate, payout state machine, holds. Idempotent. No existing ledger data is modified.

CREATE TABLE IF NOT EXISTS accounting_policy (
  key         text PRIMARY KEY,
  value       text,                 -- NULL until approved
  approved_by text,
  approved_at timestamptz,
  CHECK ((value IS NULL) = (approved_at IS NULL))
);
INSERT INTO accounting_policy(key) VALUES
  ('remainder_rule'),('hold_days'),('coin_value_usd_micros'),('min_payout_coins'),
  ('review_threshold_coins'),('clawback_mode'),('negative_balance_policy'),('chargeback_policy'),
  ('family_reversal_policy'),('refund_policy')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS accounting_policy_history (
  id bigserial PRIMARY KEY, key text NOT NULL, old_value text, new_value text NOT NULL,
  actor text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION approve_policy(p_key text, p_value text, p_actor text) RETURNS void AS $$
DECLARE old text;
BEGIN
  IF p_actor IS NULL OR p_actor = '' OR p_value IS NULL OR p_value = '' THEN RAISE EXCEPTION 'actor and value required'; END IF;
  SELECT value INTO old FROM accounting_policy WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy key %', p_key; END IF;
  UPDATE accounting_policy SET value = p_value, approved_by = p_actor, approved_at = now() WHERE key = p_key;
  INSERT INTO accounting_policy_history(key, old_value, new_value, actor) VALUES (p_key, old, p_value, p_actor);
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION approve_policy(text,text,text) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS payout_profiles (
  user_id text PRIMARY KEY,
  provider text NOT NULL DEFAULT 'stripe',
  provider_account_id text,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','pending','verified','restricted')),
  payouts_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_holds (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('refund','chargeback','admin','risk')),
  amount bigint NOT NULL CHECK (amount > 0),
  ref text, reason text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  created_by text, released_by text,
  created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE INDEX IF NOT EXISTS payout_holds_active ON payout_holds(user_id) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS payout_holds_ref_uq ON payout_holds(kind, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS payouts (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  amount_coins bigint NOT NULL CHECK (amount_coins > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),   -- currency minor units, snapshot at request time
  currency text NOT NULL,
  rate_micros bigint NOT NULL,
  status text NOT NULL CHECK (status IN
    ('pending_review','queued','processing','paid','failed','reversed','cancelled','needs_review')),
  provider text NOT NULL, provider_account_id text NOT NULL,
  provider_ref text,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  failure_reason text,
  last_actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
-- One provider transfer reference can belong to at most one payout.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_provider_ref_uq ON payouts(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS payouts_due ON payouts(next_attempt_at) WHERE status IN ('queued','processing');

CREATE TABLE IF NOT EXISTS payout_events (
  id bigserial PRIMARY KEY, payout_id bigint NOT NULL REFERENCES payouts(id),
  from_status text, to_status text NOT NULL, actor text, detail text,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION payouts_guard() RETURNS trigger AS $$
DECLARE ok boolean; missing text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT string_agg(key, ',') INTO missing FROM accounting_policy
      WHERE key IN ('hold_days','coin_value_usd_micros','min_payout_coins','review_threshold_coins','clawback_mode') AND value IS NULL;
    IF missing IS NOT NULL THEN RAISE EXCEPTION 'policy_not_approved: %', missing USING ERRCODE = 'P0428'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.amount_coins <> OLD.amount_coins OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.provider_account_id <> OLD.provider_account_id THEN
    RAISE EXCEPTION 'payout financial fields are immutable';
  END IF;
  IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    RAISE EXCEPTION 'provider_ref is immutable once set';
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := (OLD.status, NEW.status) IN (
      ('pending_review','queued'),('pending_review','cancelled'),
      ('queued','processing'),('queued','cancelled'),
      ('processing','paid'),('processing','failed'),('processing','queued'),('processing','needs_review'),
      ('needs_review','queued'),('needs_review','failed'),('needs_review','paid'),('needs_review','cancelled'),
      ('paid','reversed'));
    IF NOT ok THEN RAISE EXCEPTION 'illegal payout transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0422'; END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payouts_guard_trg ON payouts;
CREATE TRIGGER payouts_guard_trg BEFORE INSERT OR UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_guard();

CREATE OR REPLACE FUNCTION payouts_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status <> OLD.status THEN
    INSERT INTO payout_events(payout_id, from_status, to_status, actor, detail)
    VALUES (NEW.id, CASE WHEN TG_OP='UPDATE' THEN OLD.status END, NEW.status, NEW.last_actor, NEW.failure_reason);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS payouts_history_trg ON payouts;
CREATE TRIGGER payouts_history_trg AFTER INSERT OR UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_history();

CREATE OR REPLACE FUNCTION no_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payout_events_ro ON payout_events;
CREATE TRIGGER payout_events_ro BEFORE UPDATE OR DELETE ON payout_events FOR EACH ROW EXECUTE FUNCTION no_mutation();
DROP TRIGGER IF EXISTS policy_hist_ro ON accounting_policy_history;
CREATE TRIGGER policy_hist_ro BEFORE UPDATE OR DELETE ON accounting_policy_history FOR EACH ROW EXECUTE FUNCTION no_mutation();

-- Refund requests automatically hold the creator share of the disputed entry until decided.
CREATE OR REPLACE FUNCTION refund_hold() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT a.owner_id, sum(p.amount) AS amt FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
             WHERE p.entry_id = NEW.entry_id AND p.role = 'creator_share' AND a.owner_id IS NOT NULL GROUP BY a.owner_id HAVING sum(p.amount) > 0 LOOP
      INSERT INTO payout_holds(user_id, kind, amount, ref, reason, created_by)
      VALUES (r.owner_id, 'refund', r.amt, 'refund:' || NEW.id, 'refund requested', 'system') ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF NEW.status IN ('completed','rejected') AND OLD.status NOT IN ('completed','rejected') THEN
    UPDATE payout_holds SET status='released', released_at=now(), released_by='system'
     WHERE kind='refund' AND ref = 'refund:' || NEW.id AND status='active';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS refund_hold_ins ON refund_requests;
CREATE TRIGGER refund_hold_ins AFTER INSERT ON refund_requests FOR EACH ROW EXECUTE FUNCTION refund_hold();
DROP TRIGGER IF EXISTS refund_hold_upd ON refund_requests;
CREATE TRIGGER refund_hold_upd AFTER UPDATE OF status ON refund_requests FOR EACH ROW EXECUTE FUNCTION refund_hold();

-- webhook kinds for Connect events
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS detail text;
