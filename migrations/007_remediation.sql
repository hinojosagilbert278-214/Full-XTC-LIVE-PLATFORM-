-- Phase 5 remediation: four-eyes policy approval, provider-evidence gate, ledger<->payout linkage,
-- family-aware holds with lifecycle events, schema/truncate guards. Idempotent; no ledger history is modified.

-- ===== 1. Four-eyes policy approval =====
ALTER TABLE accounting_policy ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 0;
ALTER TABLE accounting_policy ADD COLUMN IF NOT EXISTS proposed_by text;
ALTER TABLE accounting_policy_history ADD COLUMN IF NOT EXISTS proposed_by text;
ALTER TABLE accounting_policy_history ADD COLUMN IF NOT EXISTS proposed_at timestamptz;
ALTER TABLE accounting_policy_history ADD COLUMN IF NOT EXISTS version int;
ALTER TABLE accounting_policy_history ADD COLUMN IF NOT EXISTS proposal_id bigint;

CREATE TABLE IF NOT EXISTS policy_proposals (
  id bigserial PRIMARY KEY,
  key text NOT NULL REFERENCES accounting_policy(key),
  value text NOT NULL CHECK (value <> ''),
  proposed_by text NOT NULL CHECK (proposed_by <> ''),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded')),
  decided_by text, decided_at timestamptz,
  -- Table-level four-eyes: holds even if the functions are bypassed.
  CHECK (decided_by IS NULL OR status = 'superseded' OR decided_by <> proposed_by),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS policy_proposals_pending ON policy_proposals(key) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION policy_value_ok(p_key text, p_value text) RETURNS boolean AS $$
  SELECT CASE
    WHEN p_key IN ('hold_days') THEN p_value ~ '^[0-9]{1,3}$' AND p_value::int <= 365
    WHEN p_key IN ('coin_value_usd_micros','min_payout_coins','review_threshold_coins') THEN p_value ~ '^[1-9][0-9]{0,17}$'
    ELSE p_value ~ '^[a-z_]{1,32}$' END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION policy_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.value IS DISTINCT FROM OLD.value OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.version IS DISTINCT FROM OLD.version)
     AND COALESCE(current_setting('xtc.policy_fn', true), '') <> 'on' THEN
    RAISE EXCEPTION 'accounting policy can only change through approve_policy_proposal()';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS policy_guard_trg ON accounting_policy;
CREATE TRIGGER policy_guard_trg BEFORE UPDATE ON accounting_policy FOR EACH ROW EXECUTE FUNCTION policy_guard();

CREATE OR REPLACE FUNCTION propose_policy(p_key text, p_value text, p_actor text) RETURNS bigint AS $$
DECLARE v_id bigint;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  PERFORM 1 FROM accounting_policy WHERE key = p_key; IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy key %', p_key; END IF;
  IF NOT policy_value_ok(p_key, p_value) THEN RAISE EXCEPTION 'invalid value for %', p_key; END IF;
  UPDATE policy_proposals SET status='superseded', decided_at=now() WHERE key=p_key AND status='pending';
  INSERT INTO policy_proposals(key, value, proposed_by) VALUES (p_key, p_value, p_actor) RETURNING id INTO v_id;
  RETURN v_id;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION approve_policy_proposal(p_id bigint, p_actor text) RETURNS void AS $$
DECLARE pr policy_proposals; old text; v int;
BEGIN
  IF p_actor IS NULL OR p_actor = '' THEN RAISE EXCEPTION 'actor required'; END IF;
  SELECT * INTO pr FROM policy_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR pr.status <> 'pending' THEN RAISE EXCEPTION 'proposal not pending'; END IF;
  IF pr.proposed_by = p_actor THEN RAISE EXCEPTION 'four-eyes: proposer cannot approve' USING ERRCODE = 'P0403'; END IF;
  PERFORM set_config('xtc.policy_fn', 'on', true);
  SELECT value, version INTO old, v FROM accounting_policy WHERE key = pr.key FOR UPDATE;
  UPDATE accounting_policy SET value = pr.value, approved_by = p_actor, proposed_by = pr.proposed_by, approved_at = now(), version = v + 1 WHERE key = pr.key;
  UPDATE policy_proposals SET status='approved', decided_by=p_actor, decided_at=now() WHERE id = p_id;
  INSERT INTO accounting_policy_history(key, old_value, new_value, actor, proposed_by, proposed_at, version, proposal_id)
  VALUES (pr.key, old, pr.value, p_actor, pr.proposed_by, pr.proposed_at, v + 1, p_id);
  PERFORM set_config('xtc.policy_fn', 'off', true);
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reject_policy_proposal(p_id bigint, p_actor text) RETURNS void AS $$
BEGIN
  UPDATE policy_proposals SET status='rejected', decided_by=p_actor, decided_at=now() WHERE id=p_id AND status='pending' AND proposed_by <> p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'proposal not pending or proposer cannot reject'; END IF;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The single-actor approval path from migration 005 is removed.
DROP FUNCTION IF EXISTS approve_policy(text, text, text);
REVOKE ALL ON FUNCTION propose_policy(text,text,text), approve_policy_proposal(bigint,text), reject_policy_proposal(bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION propose_policy(text,text,text), approve_policy_proposal(bigint,text), reject_policy_proposal(bigint,text) TO xtc_admin;
GRANT SELECT ON policy_proposals TO xtc_app, xtc_admin, xtc_readonly;

-- ===== 2. Provider evidence gate for 'paid' =====
CREATE TABLE IF NOT EXISTS payout_provider_evidence (
  id bigserial PRIMARY KEY,
  payout_id bigint NOT NULL UNIQUE REFERENCES payouts(id),
  provider text NOT NULL, provider_ref text NOT NULL,
  amount_minor bigint NOT NULL, currency text NOT NULL,
  source text NOT NULL CHECK (source IN ('create_response','provider_lookup','provider_webhook')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
DROP TRIGGER IF EXISTS evidence_ro ON payout_provider_evidence;
CREATE TRIGGER evidence_ro BEFORE UPDATE OR DELETE ON payout_provider_evidence FOR EACH ROW EXECUTE FUNCTION no_mutation();
GRANT SELECT, INSERT ON payout_provider_evidence TO xtc_app;
GRANT SELECT ON payout_provider_evidence TO xtc_admin, xtc_readonly;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO xtc_app, xtc_admin;

-- ===== 3. Ledger <-> payout linkage =====
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS reserve_entry bigint REFERENCES journal_entries(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS settle_entry  bigint REFERENCES journal_entries(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS return_entry  bigint REFERENCES journal_entries(id);
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS reverse_entry bigint REFERENCES journal_entries(id);
CREATE UNIQUE INDEX IF NOT EXISTS payouts_reserve_entry_uq ON payouts(reserve_entry) WHERE reserve_entry IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payouts_settle_entry_uq  ON payouts(settle_entry)  WHERE settle_entry  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payouts_return_entry_uq  ON payouts(return_entry)  WHERE return_entry  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payouts_reverse_entry_uq ON payouts(reverse_entry) WHERE reverse_entry IS NOT NULL;

CREATE OR REPLACE FUNCTION entry_matches(p_entry bigint, p_type text, a1 text, v1 bigint, a2 text, v2 bigint) RETURNS boolean AS $$
  SELECT p_entry IS NOT NULL
     AND (SELECT type FROM journal_entries WHERE id = p_entry) = p_type
     AND (SELECT count(*) FROM postings WHERE entry_id = p_entry) = 2
     AND EXISTS (SELECT 1 FROM postings WHERE entry_id = p_entry AND account_id = a1 AND amount = v1)
     AND EXISTS (SELECT 1 FROM postings WHERE entry_id = p_entry AND account_id = a2 AND amount = v2)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Evaluated at COMMIT against the final row: a payout can never be committed without the exact ledger movements its status implies.
CREATE OR REPLACE FUNCTION payouts_ledger_check() RETURNS trigger AS $$
DECLARE p payouts; e text; amt bigint;
BEGIN
  SELECT * INTO p FROM payouts WHERE id = NEW.id;
  amt := p.amount_coins; e := 'earnings:' || p.user_id;
  IF NOT entry_matches(p.reserve_entry, 'payout_reserve', e, -amt, 'payout:clearing', amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching reserve ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status IN ('paid','reversed') AND NOT entry_matches(p.settle_entry, 'payout_settle', 'payout:clearing', -amt, 'payout:paid', amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching settle ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status IN ('failed','cancelled') AND NOT entry_matches(p.return_entry, 'payout_return', 'payout:clearing', -amt, e, amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching return ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status = 'reversed' AND NOT entry_matches(p.reverse_entry, 'payout_reverse', 'payout:paid', -amt, e, amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching reverse ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status NOT IN ('paid','reversed') AND p.settle_entry IS NOT NULL
     OR p.status NOT IN ('failed','cancelled') AND p.return_entry IS NOT NULL
     OR p.status <> 'reversed' AND p.reverse_entry IS NOT NULL THEN
    RAISE EXCEPTION 'payout % has ledger links inconsistent with status %', p.id, p.status USING ERRCODE = 'P0430'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS payouts_ledger_chk ON payouts;
CREATE CONSTRAINT TRIGGER payouts_ledger_chk AFTER INSERT OR UPDATE ON payouts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payouts_ledger_check();

-- Reverse direction: no ledger movement may touch payout accounts unless a payout row owns it.
CREATE OR REPLACE FUNCTION payout_entry_orphan_check() RETURNS trigger AS $$
BEGIN
  IF NEW.type LIKE 'payout\_%' OR EXISTS (SELECT 1 FROM postings WHERE entry_id = NEW.id AND account_id IN ('payout:clearing','payout:paid')) THEN
    IF NEW.type NOT LIKE 'payout\_%' OR NOT EXISTS (
      SELECT 1 FROM payouts WHERE NEW.id IN (reserve_entry, settle_entry, return_entry, reverse_entry)) THEN
      RAISE EXCEPTION 'ledger entry % touches payout accounts without a payout record', NEW.id USING ERRCODE = 'P0431'; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS payout_entry_orphan_chk ON journal_entries;
CREATE CONSTRAINT TRIGGER payout_entry_orphan_chk AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payout_entry_orphan_check();

-- Guard: set-once ledger links, evidence required for 'paid'.
CREATE OR REPLACE FUNCTION payouts_guard() RETURNS trigger AS $$
DECLARE ok boolean; missing text; ev payout_provider_evidence;
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
  IF (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
     OR (OLD.reserve_entry IS NOT NULL AND NEW.reserve_entry IS DISTINCT FROM OLD.reserve_entry)
     OR (OLD.settle_entry  IS NOT NULL AND NEW.settle_entry  IS DISTINCT FROM OLD.settle_entry)
     OR (OLD.return_entry  IS NOT NULL AND NEW.return_entry  IS DISTINCT FROM OLD.return_entry)
     OR (OLD.reverse_entry IS NOT NULL AND NEW.reverse_entry IS DISTINCT FROM OLD.reverse_entry) THEN
    RAISE EXCEPTION 'provider_ref and ledger links are immutable once set';
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := (OLD.status, NEW.status) IN (
      ('pending_review','queued'),('pending_review','cancelled'),
      ('queued','processing'),('queued','cancelled'),
      ('processing','paid'),('processing','failed'),('processing','queued'),('processing','needs_review'),
      ('needs_review','queued'),('needs_review','failed'),('needs_review','paid'),('needs_review','cancelled'),
      ('paid','reversed'));
    IF NOT ok THEN RAISE EXCEPTION 'illegal payout transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0422'; END IF;
    IF NEW.status = 'paid' THEN
      SELECT * INTO ev FROM payout_provider_evidence WHERE payout_id = NEW.id;
      IF NOT FOUND OR ev.provider <> NEW.provider OR ev.provider_ref IS DISTINCT FROM NEW.provider_ref
         OR ev.amount_minor <> NEW.amount_minor OR ev.currency <> NEW.currency THEN
        RAISE EXCEPTION 'payout % cannot be marked paid without matching provider evidence', NEW.id USING ERRCODE = 'P0432'; END IF;
      IF OLD.status = 'needs_review' AND ev.source = 'create_response' THEN
        RAISE EXCEPTION 'needs_review -> paid requires provider lookup/webhook evidence' USING ERRCODE = 'P0432'; END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ===== 4. Family-aware holds with lifecycle =====
ALTER TABLE payout_holds ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE payout_holds ADD COLUMN IF NOT EXISTS settled_entry bigint REFERENCES journal_entries(id);
UPDATE payout_holds SET account_id = 'earnings:' || user_id WHERE account_id IS NULL;
ALTER TABLE payout_holds DROP CONSTRAINT IF EXISTS payout_holds_status_check;
ALTER TABLE payout_holds ADD CONSTRAINT payout_holds_status_check CHECK (status IN ('active','released','consumed'));
CREATE INDEX IF NOT EXISTS payout_holds_acct_active ON payout_holds(account_id) WHERE status = 'active';

CREATE OR REPLACE FUNCTION payout_holds_defaults() RETURNS trigger AS $$
BEGIN IF NEW.account_id IS NULL THEN NEW.account_id := 'earnings:' || NEW.user_id; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payout_holds_defaults_trg ON payout_holds;
CREATE TRIGGER payout_holds_defaults_trg BEFORE INSERT ON payout_holds FOR EACH ROW EXECUTE FUNCTION payout_holds_defaults();

CREATE TABLE IF NOT EXISTS payout_hold_events (
  id bigserial PRIMARY KEY, hold_id bigint NOT NULL REFERENCES payout_holds(id),
  action text NOT NULL CHECK (action IN ('created','released','consumed')),
  actor text, entry_id bigint, amount bigint NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS hold_events_ro ON payout_hold_events;
CREATE TRIGGER hold_events_ro BEFORE UPDATE OR DELETE ON payout_hold_events FOR EACH ROW EXECUTE FUNCTION no_mutation();
CREATE OR REPLACE FUNCTION payout_holds_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO payout_hold_events(hold_id, action, actor, amount) VALUES (NEW.id, 'created', NEW.created_by, NEW.amount);
  ELSIF NEW.status <> OLD.status THEN
    IF OLD.status <> 'active' THEN RAISE EXCEPTION 'hold already %', OLD.status; END IF;
    INSERT INTO payout_hold_events(hold_id, action, actor, entry_id, amount) VALUES (NEW.id, NEW.status, NEW.released_by, NEW.settled_entry, NEW.amount);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS payout_holds_history_trg ON payout_holds;
CREATE TRIGGER payout_holds_history_trg AFTER INSERT OR UPDATE ON payout_holds FOR EACH ROW EXECUTE FUNCTION payout_holds_history();
GRANT SELECT ON payout_hold_events TO xtc_app, xtc_admin, xtc_readonly;

-- Refund request holds the creator AND family share of the disputed entry; completion consumes, rejection releases.
CREATE OR REPLACE FUNCTION refund_hold() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT a.id AS acct, a.owner_id, sum(p.amount) AS amt FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
             WHERE p.entry_id = NEW.entry_id AND p.role IN ('creator_share','family_share') AND a.owner_id IS NOT NULL
             GROUP BY a.id, a.owner_id HAVING sum(p.amount) > 0 LOOP
      INSERT INTO payout_holds(user_id, account_id, kind, amount, ref, reason, created_by)
      VALUES (r.owner_id, r.acct, 'refund', r.amt, 'refund:' || NEW.id || ':' || r.acct, 'refund requested', 'system') ON CONFLICT DO NOTHING;
    END LOOP;
  ELSIF NEW.status IN ('completed','rejected') AND OLD.status NOT IN ('completed','rejected') THEN
    UPDATE payout_holds SET status = CASE WHEN NEW.status = 'completed' THEN 'consumed' ELSE 'released' END,
           released_at = now(), released_by = 'system', settled_entry = CASE WHEN NEW.status = 'completed' THEN NEW.reversal_entry END
     WHERE kind = 'refund' AND ref LIKE 'refund:' || NEW.id || ':%' AND status = 'active';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Chargeback: hold the creator/family shares of the charged-back user's recent gifts, newest first, up to the coins
-- that can no longer be recovered from the wallet. Protective, so it works before accounting policy approval.
CREATE OR REPLACE FUNCTION place_chargeback_holds(p_purchase_entry bigint, p_lookback_days int DEFAULT 90) RETURNS int AS $$
DECLARE v_user text; v_coins bigint; v_wallet bigint; v_unrec bigint; g record; r record; take bigint; amt bigint; n int := 0;
BEGIN
  SELECT a.owner_id, p.amount INTO v_user, v_coins FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
   WHERE p.entry_id = p_purchase_entry AND a.kind = 'user_wallet' AND p.amount > 0 LIMIT 1;
  IF v_user IS NULL THEN RETURN 0; END IF;
  SELECT balance INTO v_wallet FROM ledger_accounts WHERE id = 'wallet:' || v_user;
  v_unrec := v_coins - GREATEST(COALESCE(v_wallet, 0), 0);
  IF v_unrec <= 0 THEN RETURN 0; END IF;
  FOR g IN SELECT e.id AS eid, -w.amount AS gross FROM postings w JOIN journal_entries e ON e.id = w.entry_id
            WHERE w.account_id = 'wallet:' || v_user AND w.role = 'gift_debit' AND e.created_at > now() - make_interval(days => p_lookback_days)
              AND NOT EXISTS (SELECT 1 FROM journal_entries rv WHERE rv.reverses_entry = e.id)
            ORDER BY e.id DESC LOOP
    EXIT WHEN v_unrec <= 0;
    take := LEAST(v_unrec, g.gross);
    FOR r IN SELECT p.account_id, a.owner_id, p.amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
              WHERE p.entry_id = g.eid AND p.role IN ('creator_share','family_share') AND a.owner_id IS NOT NULL LOOP
      amt := LEAST(r.amount, (take * r.amount + g.gross - 1) / g.gross); -- round up: over-hold rather than under-hold
      IF amt > 0 THEN
        INSERT INTO payout_holds(user_id, account_id, kind, amount, ref, reason, created_by)
        VALUES (r.owner_id, r.account_id, 'chargeback', amt, 'cb:' || p_purchase_entry || ':' || g.eid || ':' || r.account_id, 'chargeback of entry ' || p_purchase_entry, 'system')
        ON CONFLICT DO NOTHING;
        IF FOUND THEN n := n + 1; END IF;
      END IF;
    END LOOP;
    v_unrec := v_unrec - take;
  END LOOP;
  RETURN n;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_chargeback_holds(bigint,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION place_chargeback_holds(bigint,int) TO xtc_app, xtc_admin;
-- Admin hold resolution columns
GRANT UPDATE (status, released_at, released_by, settled_entry) ON payout_holds TO xtc_admin;

-- ===== 5. Schema / destructive-operation guards =====
CREATE TABLE IF NOT EXISTS ddl_audit (id bigserial PRIMARY KEY, actor text NOT NULL, note text, at timestamptz NOT NULL DEFAULT now());
DROP TRIGGER IF EXISTS ddl_audit_ro ON ddl_audit;
CREATE TRIGGER ddl_audit_ro BEFORE UPDATE OR DELETE ON ddl_audit FOR EACH ROW EXECUTE FUNCTION no_mutation();
GRANT SELECT ON ddl_audit TO xtc_readonly, xtc_admin;

CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
  IF COALESCE(current_setting('xtc.allow_destructive', true), '') = 'on' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'TRUNCATE of % is blocked (set xtc.allow_destructive only in non-production tooling)', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries','postings','ledger_accounts','audit_log','payouts','payout_events','payout_provider_evidence',
                           'accounting_policy','accounting_policy_history','policy_proposals','payout_holds','payout_hold_events','ddl_audit'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS no_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ddl_guard() RETURNS event_trigger AS $$
BEGIN
  IF COALESCE(current_setting('xtc.migrating', true), '') = 'on' THEN RETURN; END IF;
  RAISE EXCEPTION 'schema/trigger/function changes are blocked outside migrations (command: %)', tg_tag;
END $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'xtc_ddl_guard') THEN
    CREATE EVENT TRIGGER xtc_ddl_guard ON ddl_command_start
      WHEN TAG IN ('ALTER TABLE','DROP TABLE','CREATE TRIGGER','DROP TRIGGER','CREATE FUNCTION','DROP FUNCTION','ALTER FUNCTION')
      EXECUTE FUNCTION ddl_guard();
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'xtc_ddl_guard NOT installed: superuser required once (see docs/OPERATIONS.md)';
END $$;
