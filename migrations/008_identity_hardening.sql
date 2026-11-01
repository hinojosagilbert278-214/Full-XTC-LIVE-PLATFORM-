-- Migration 008: closes the gaps found in review of 007. No ledger history is modified. Idempotent.
--
-- Principle: no control may depend on a value the caller can set (actor strings, GUCs, source labels).
-- Identity comes from session_user (the authenticated login; unaffected by SET ROLE, changeable only by a superuser).
-- Group membership is read DIRECTLY from pg_auth_members, because pg_has_role() is always true for superusers.
-- Residual: a PostgreSQL superuser can still bypass everything here (see docs/OPERATIONS.md); this is not tamper-proof.
--
-- NOTE: migrations are replayed in order on every `npm run migrate`; 007 recreates its (weaker) definitions inside the
-- same transaction and this file replaces them again before commit, so the committed state is always the 008 state.

-- ===== 0. Roles and identity helpers =====
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['xtc_policy_admin','xtc_provider_worker','xtc_migrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
  END LOOP;
END $$;
-- The worker identity does everything the app does plus evidence recording.
GRANT xtc_app TO xtc_provider_worker;
-- Development/CI convenience: whoever runs the migration becomes a migrator. In production a DBA grants xtc_migrator to a
-- dedicated migration login and runtime logins never get it. Skipped (not failed) when the migrating role cannot grant.
DO $$ BEGIN
  EXECUTE format('GRANT xtc_migrator TO %I', session_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'could not grant xtc_migrator to %; a DBA must do this (docs/OPERATIONS.md)', session_user;
END $$;

CREATE OR REPLACE FUNCTION is_direct_member(p_role text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM pg_auth_members m
                   JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                  WHERE g.rolname = p_role AND u.rolname = session_user)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

-- True for non-superuser runtime identities (app / admin / worker). Deliberately SECURITY INVOKER: it must see the CALLER's
-- current_user, so rows written from inside the system SECURITY DEFINER functions (owned by the migrator) are not runtime writes.
CREATE OR REPLACE FUNCTION is_runtime_identity() RETURNS boolean AS $$
  SELECT NOT r.rolsuper AND (pg_has_role(current_user, 'xtc_app', 'MEMBER') OR pg_has_role(current_user, 'xtc_admin', 'MEMBER'))
    FROM pg_roles r WHERE r.rolname = current_user
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public;

-- ===== 1. Policy: validation, identity-based four-eyes, no GUC bypass =====
ALTER TABLE accounting_policy ADD COLUMN IF NOT EXISTS proposal_id bigint;

CREATE OR REPLACE FUNCTION policy_value_ok(p_key text, p_value text) RETURNS boolean AS $$
  SELECT CASE p_key
    WHEN 'hold_days'               THEN CASE WHEN p_value ~ '^(0|[1-9][0-9]{0,2})$'  THEN p_value::int    BETWEEN 0 AND 365 ELSE false END
    WHEN 'coin_value_usd_micros'   THEN CASE WHEN p_value ~ '^[1-9][0-9]{0,6}$'      THEN p_value::bigint BETWEEN 1 AND 1000000 ELSE false END
    WHEN 'min_payout_coins'        THEN CASE WHEN p_value ~ '^[1-9][0-9]{0,11}$'     THEN p_value::bigint BETWEEN 1 AND 1000000000 ELSE false END
    WHEN 'review_threshold_coins'  THEN CASE WHEN p_value ~ '^[1-9][0-9]{0,12}$'     THEN p_value::bigint BETWEEN 1 AND 1000000000000 ELSE false END
    WHEN 'remainder_rule'          THEN p_value IN ('platform','creator')
    WHEN 'clawback_mode'           THEN p_value IN ('debt','manual_review')
    WHEN 'negative_balance_policy' THEN p_value IN ('debt_account','block')
    WHEN 'chargeback_policy'       THEN p_value IN ('freeze_and_hold','hold_only')
    WHEN 'family_reversal_policy'  THEN p_value IN ('debt_account','creator_absorbs')
    WHEN 'refund_policy'           THEN p_value IN ('exact_reversal','admin_review')
    ELSE false END
$$ LANGUAGE sql IMMUTABLE;

-- One pending proposal per key; superseded rows record who superseded them.
UPDATE policy_proposals p SET status = 'superseded', decided_at = now(), decided_by = COALESCE(decided_by, proposed_by)
 WHERE status = 'pending' AND id < (SELECT max(id) FROM policy_proposals q WHERE q.key = p.key AND q.status = 'pending');
CREATE UNIQUE INDEX IF NOT EXISTS policy_proposals_one_pending ON policy_proposals(key) WHERE status = 'pending';
ALTER TABLE policy_proposals DROP CONSTRAINT IF EXISTS policy_proposals_decided_by_required;
ALTER TABLE policy_proposals ADD CONSTRAINT policy_proposals_decided_by_required
  CHECK (status NOT IN ('approved','rejected') OR (decided_by IS NOT NULL AND decided_by <> '')) NOT VALID;

CREATE OR REPLACE FUNCTION policy_proposals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'policy proposals are append-only' USING ERRCODE = 'P0403'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'proposals must be inserted as pending' USING ERRCODE = 'P0403'; END IF;
    IF NEW.proposed_by <> session_user OR NOT is_direct_member('xtc_policy_admin') THEN
      RAISE EXCEPTION 'proposer must be the authenticated session login and a direct xtc_policy_admin member' USING ERRCODE = 'P0403'; END IF;
    IF NOT policy_value_ok(NEW.key, NEW.value) THEN RAISE EXCEPTION 'invalid value for %', NEW.key USING ERRCODE = 'P0442'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.key <> OLD.key OR NEW.value <> OLD.value OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at THEN
    RAISE EXCEPTION 'proposal content is immutable' USING ERRCODE = 'P0403'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'proposal already %', OLD.status USING ERRCODE = 'P0403'; END IF;
  IF NEW.status = 'pending' THEN RAISE EXCEPTION 'no-op proposal update' USING ERRCODE = 'P0403'; END IF;
  IF NEW.decided_by IS DISTINCT FROM session_user OR NOT is_direct_member('xtc_policy_admin') THEN
    RAISE EXCEPTION 'decider must be the authenticated session login and a direct xtc_policy_admin member' USING ERRCODE = 'P0403'; END IF;
  IF NEW.status IN ('approved','rejected') AND NEW.decided_by = OLD.proposed_by THEN
    RAISE EXCEPTION 'four-eyes: proposer cannot decide their own proposal' USING ERRCODE = 'P0403'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS policy_proposals_guard_trg ON policy_proposals;
CREATE TRIGGER policy_proposals_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON policy_proposals
  FOR EACH ROW EXECUTE FUNCTION policy_proposals_guard();

-- State-based guard: an accounting_policy row may only change to exactly what one approved, unused proposal says.
CREATE OR REPLACE FUNCTION policy_guard() RETURNS trigger AS $$
DECLARE pr policy_proposals;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'accounting policy rows cannot be deleted' USING ERRCODE = 'P0403'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.value IS NOT NULL OR NOT is_direct_member('xtc_migrator') THEN
      RAISE EXCEPTION 'policy rows may only be seeded unapproved by a migrator' USING ERRCODE = 'P0403'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.key <> OLD.key THEN RAISE EXCEPTION 'policy key is immutable' USING ERRCODE = 'P0403'; END IF;
  IF ROW(NEW.value, NEW.approved_by, NEW.approved_at, NEW.version, NEW.proposed_by, NEW.proposal_id)
     IS NOT DISTINCT FROM ROW(OLD.value, OLD.approved_by, OLD.approved_at, OLD.version, OLD.proposed_by, OLD.proposal_id) THEN RETURN NEW; END IF;
  SELECT * INTO pr FROM policy_proposals WHERE id = NEW.proposal_id;
  IF NOT FOUND OR pr.status <> 'approved' OR pr.key <> NEW.key OR pr.value IS DISTINCT FROM NEW.value
     OR pr.decided_by IS DISTINCT FROM NEW.approved_by OR pr.proposed_by IS DISTINCT FROM NEW.proposed_by
     OR pr.decided_by = pr.proposed_by OR NEW.version <> COALESCE(OLD.version, 0) + 1
     OR EXISTS (SELECT 1 FROM accounting_policy_history h WHERE h.proposal_id = NEW.proposal_id) THEN
    RAISE EXCEPTION 'accounting policy can only change to the value of one approved, unused two-person proposal' USING ERRCODE = 'P0403';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS policy_guard_trg ON accounting_policy;
CREATE TRIGGER policy_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON accounting_policy FOR EACH ROW EXECUTE FUNCTION policy_guard();
CREATE UNIQUE INDEX IF NOT EXISTS policy_history_proposal_uq ON accounting_policy_history(proposal_id) WHERE proposal_id IS NOT NULL;

DROP FUNCTION IF EXISTS propose_policy(text, text, text);
DROP FUNCTION IF EXISTS approve_policy_proposal(bigint, text);
DROP FUNCTION IF EXISTS reject_policy_proposal(bigint, text);
DROP FUNCTION IF EXISTS approve_policy(text, text, text);

CREATE OR REPLACE FUNCTION propose_policy(p_key text, p_value text) RETURNS bigint AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT is_direct_member('xtc_policy_admin') THEN RAISE EXCEPTION 'not a policy administrator' USING ERRCODE = 'P0403'; END IF;
  -- Serializes concurrent proposals for the same key; the partial unique index is the backstop.
  PERFORM 1 FROM accounting_policy WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown policy key %', p_key; END IF;
  IF NOT policy_value_ok(p_key, p_value) THEN RAISE EXCEPTION 'invalid value for %', p_key USING ERRCODE = 'P0442'; END IF;
  UPDATE policy_proposals SET status = 'superseded', decided_by = session_user, decided_at = now() WHERE key = p_key AND status = 'pending';
  INSERT INTO policy_proposals(key, value, proposed_by) VALUES (p_key, p_value, session_user) RETURNING id INTO v_id;
  RETURN v_id;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION approve_policy_proposal(p_id bigint) RETURNS void AS $$
DECLARE pr policy_proposals; old text; v int; other text;
BEGIN
  IF NOT is_direct_member('xtc_policy_admin') THEN RAISE EXCEPTION 'not a policy administrator' USING ERRCODE = 'P0403'; END IF;
  SELECT * INTO pr FROM policy_proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR pr.status <> 'pending' THEN RAISE EXCEPTION 'proposal not pending'; END IF;
  IF pr.proposed_by = session_user THEN RAISE EXCEPTION 'four-eyes: proposer cannot approve' USING ERRCODE = 'P0403'; END IF;
  SELECT value, version INTO old, v FROM accounting_policy WHERE key = pr.key FOR UPDATE;
  IF NOT policy_value_ok(pr.key, pr.value) THEN RAISE EXCEPTION 'invalid value for %', pr.key USING ERRCODE = 'P0442'; END IF;
  IF pr.key = 'min_payout_coins' THEN
    SELECT value INTO other FROM accounting_policy WHERE key = 'review_threshold_coins';
    IF other IS NOT NULL AND pr.value::bigint > other::bigint THEN RAISE EXCEPTION 'min_payout_coins cannot exceed review_threshold_coins' USING ERRCODE = 'P0442'; END IF;
  ELSIF pr.key = 'review_threshold_coins' THEN
    SELECT value INTO other FROM accounting_policy WHERE key = 'min_payout_coins';
    IF other IS NOT NULL AND pr.value::bigint < other::bigint THEN RAISE EXCEPTION 'review_threshold_coins cannot be below min_payout_coins' USING ERRCODE = 'P0442'; END IF;
  END IF;
  UPDATE policy_proposals SET status = 'approved', decided_by = session_user, decided_at = now() WHERE id = p_id;
  UPDATE accounting_policy SET value = pr.value, approved_by = session_user, proposed_by = pr.proposed_by, approved_at = now(),
         version = v + 1, proposal_id = p_id WHERE key = pr.key;
  INSERT INTO accounting_policy_history(key, old_value, new_value, actor, proposed_by, proposed_at, version, proposal_id)
  VALUES (pr.key, old, pr.value, session_user, pr.proposed_by, pr.proposed_at, v + 1, p_id);
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION reject_policy_proposal(p_id bigint) RETURNS void AS $$
BEGIN
  IF NOT is_direct_member('xtc_policy_admin') THEN RAISE EXCEPTION 'not a policy administrator' USING ERRCODE = 'P0403'; END IF;
  UPDATE policy_proposals SET status = 'rejected', decided_by = session_user, decided_at = now()
   WHERE id = p_id AND status = 'pending' AND proposed_by <> session_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'proposal not pending or proposer cannot reject'; END IF;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION propose_policy(text,text), approve_policy_proposal(bigint), reject_policy_proposal(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION propose_policy(text,text), approve_policy_proposal(bigint), reject_policy_proposal(bigint) TO xtc_policy_admin;
GRANT SELECT ON accounting_policy, accounting_policy_history, policy_proposals TO xtc_policy_admin;
GRANT USAGE ON SCHEMA public TO xtc_policy_admin;

-- ===== 2. Provider evidence: append-only observation history, worker-only ingestion =====
ALTER TABLE payout_provider_evidence DROP CONSTRAINT IF EXISTS payout_provider_evidence_payout_id_key;
ALTER TABLE payout_provider_evidence DROP CONSTRAINT IF EXISTS payout_provider_evidence_provider_provider_ref_key;
ALTER TABLE payout_provider_evidence ADD COLUMN IF NOT EXISTS observation_ref text;
ALTER TABLE payout_provider_evidence ADD COLUMN IF NOT EXISTS verification jsonb NOT NULL DEFAULT '{}';
ALTER TABLE payout_provider_evidence ADD COLUMN IF NOT EXISTS recorded_by text;
-- Backfill predates the append-only trigger being re-checked; done with triggers as they are by the migrator only on first run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM payout_provider_evidence WHERE observation_ref IS NULL OR recorded_by IS NULL) THEN
    ALTER TABLE payout_provider_evidence DISABLE TRIGGER evidence_ro;
    UPDATE payout_provider_evidence SET observation_ref = COALESCE(observation_ref, provider_ref), recorded_by = COALESCE(recorded_by, 'legacy-007');
    ALTER TABLE payout_provider_evidence ENABLE TRIGGER evidence_ro;
  END IF;
END $$;
ALTER TABLE payout_provider_evidence ALTER COLUMN observation_ref SET NOT NULL;
ALTER TABLE payout_provider_evidence ALTER COLUMN recorded_by SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payout_evidence_obs_uq ON payout_provider_evidence(payout_id, source, observation_ref);
CREATE INDEX IF NOT EXISTS payout_evidence_ref ON payout_provider_evidence(provider, provider_ref);

CREATE OR REPLACE FUNCTION evidence_guard() RETURNS trigger AS $$
DECLARE p payouts;
BEGIN
  IF NOT is_direct_member('xtc_provider_worker') THEN
    RAISE EXCEPTION 'provider evidence may only be recorded by a provider-worker identity' USING ERRCODE = 'P0433'; END IF;
  IF NEW.source NOT IN ('create_response','provider_lookup') THEN
    RAISE EXCEPTION 'evidence source % has no ingestion path yet', NEW.source USING ERRCODE = 'P0433'; END IF;
  NEW.recorded_by := session_user;
  PERFORM pg_advisory_xact_lock(hashtext('evidence:' || NEW.provider || ':' || NEW.provider_ref));
  SELECT * INTO p FROM payouts WHERE id = NEW.payout_id;
  IF NOT FOUND OR p.status NOT IN ('processing','needs_review','paid')
     OR p.provider <> NEW.provider OR p.amount_minor <> NEW.amount_minor OR p.currency <> NEW.currency
     OR (p.provider_ref IS NOT NULL AND p.provider_ref <> NEW.provider_ref) THEN
    RAISE EXCEPTION 'evidence does not match payout %', NEW.payout_id USING ERRCODE = 'P0433'; END IF;
  IF EXISTS (SELECT 1 FROM payout_provider_evidence e WHERE e.provider = NEW.provider AND e.provider_ref = NEW.provider_ref AND e.payout_id <> NEW.payout_id) THEN
    RAISE EXCEPTION 'provider reference % already attributed to another payout', NEW.provider_ref USING ERRCODE = 'P0434'; END IF;
  IF EXISTS (SELECT 1 FROM payout_provider_evidence e WHERE e.payout_id = NEW.payout_id AND e.provider_ref <> NEW.provider_ref) THEN
    RAISE EXCEPTION 'payout % already has evidence with a different provider reference', NEW.payout_id USING ERRCODE = 'P0434'; END IF;
  IF NEW.source = 'provider_lookup' AND NEW.verification->>'transfer_group' IS DISTINCT FROM 'payout-' || NEW.payout_id THEN
    RAISE EXCEPTION 'lookup evidence must carry the payout transfer_group' USING ERRCODE = 'P0433'; END IF;
  IF NEW.source = 'create_response' AND NEW.verification->>'idempotency_key' IS DISTINCT FROM 'payout-' || NEW.payout_id THEN
    RAISE EXCEPTION 'create evidence must carry the payout idempotency key' USING ERRCODE = 'P0433'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS evidence_guard_trg ON payout_provider_evidence;
CREATE TRIGGER evidence_guard_trg BEFORE INSERT ON payout_provider_evidence FOR EACH ROW EXECUTE FUNCTION evidence_guard();

DROP FUNCTION IF EXISTS record_provider_evidence(bigint,text,text,bigint,text,text,text,jsonb);
CREATE OR REPLACE FUNCTION record_provider_evidence(p_payout bigint, p_provider text, p_ref text, p_amount bigint, p_currency text,
                                                    p_source text, p_verification jsonb) RETURNS bigint AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO payout_provider_evidence(payout_id, provider, provider_ref, amount_minor, currency, source, observation_ref, verification, recorded_by)
  VALUES (p_payout, p_provider, p_ref, p_amount, p_currency, p_source, p_ref, COALESCE(p_verification, '{}'), session_user)
  ON CONFLICT (payout_id, source, observation_ref) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM payout_provider_evidence WHERE payout_id = p_payout AND source = p_source AND observation_ref = p_ref; END IF;
  RETURN v_id;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION record_provider_evidence(bigint,text,text,bigint,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_provider_evidence(bigint,text,text,bigint,text,text,jsonb) TO xtc_provider_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON payout_provider_evidence FROM xtc_app, xtc_admin, xtc_readonly, xtc_provider_worker, PUBLIC;
GRANT SELECT ON payout_provider_evidence TO xtc_app, xtc_admin, xtc_readonly;

-- ===== 3. Payout <-> ledger ownership, initial state, evidence-gated paid =====
-- The entry must also be the exact idempotency key and metadata.payoutId that names this payout.
CREATE OR REPLACE FUNCTION entry_matches(p_entry bigint, p_payout bigint, p_kind text, p_type text, a1 text, v1 bigint, a2 text, v2 bigint) RETURNS boolean AS $$
  SELECT p_entry IS NOT NULL
     AND EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = p_entry AND j.type = p_type
                   AND j.idempotency_key = 'payout:' || p_payout || ':' || p_kind
                   AND j.metadata->>'payoutId' = p_payout::text)
     AND (SELECT count(*) FROM postings WHERE entry_id = p_entry) = 2
     AND EXISTS (SELECT 1 FROM postings WHERE entry_id = p_entry AND account_id = a1 AND amount = v1)
     AND EXISTS (SELECT 1 FROM postings WHERE entry_id = p_entry AND account_id = a2 AND amount = v2)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION payouts_ledger_check() RETURNS trigger AS $$
DECLARE p payouts; e text; amt bigint;
BEGIN
  SELECT * INTO p FROM payouts WHERE id = NEW.id;
  amt := p.amount_coins; e := 'earnings:' || p.user_id;
  IF NOT entry_matches(p.reserve_entry, p.id, 'reserve', 'payout_reserve', e, -amt, 'payout:clearing', amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching reserve ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status IN ('paid','reversed') AND NOT entry_matches(p.settle_entry, p.id, 'settle', 'payout_settle', 'payout:clearing', -amt, 'payout:paid', amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching settle ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status IN ('failed','cancelled') AND NOT entry_matches(p.return_entry, p.id, 'return', 'payout_return', 'payout:clearing', -amt, e, amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching return ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status = 'reversed' AND NOT entry_matches(p.reverse_entry, p.id, 'reverse', 'payout_reverse', 'payout:paid', -amt, e, amt) THEN
    RAISE EXCEPTION 'payout % lacks a matching reverse ledger entry', p.id USING ERRCODE = 'P0430'; END IF;
  IF p.status NOT IN ('paid','reversed') AND p.settle_entry IS NOT NULL
     OR p.status NOT IN ('failed','cancelled') AND p.return_entry IS NOT NULL
     OR p.status <> 'reversed' AND p.reverse_entry IS NOT NULL THEN
    RAISE EXCEPTION 'payout % has ledger links inconsistent with status %', p.id, p.status USING ERRCODE = 'P0430'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- An entry that touches payout accounts (or claims a payout type) must name an existing payout through metadata.payoutId,
-- be that payout's linked entry of the same kind, and carry the matching idempotency key.
CREATE OR REPLACE FUNCTION payout_entry_orphan_check() RETURNS trigger AS $$
DECLARE v_pid bigint; v_kind text;
BEGIN
  IF NEW.type LIKE 'payout\_%' OR EXISTS (SELECT 1 FROM postings WHERE entry_id = NEW.id AND account_id IN ('payout:clearing','payout:paid')) THEN
    v_kind := CASE NEW.type WHEN 'payout_reserve' THEN 'reserve' WHEN 'payout_settle' THEN 'settle' WHEN 'payout_return' THEN 'return' WHEN 'payout_reverse' THEN 'reverse' END;
    v_pid := CASE WHEN NEW.metadata->>'payoutId' ~ '^[0-9]{1,18}$' THEN (NEW.metadata->>'payoutId')::bigint END;
    IF v_kind IS NULL OR v_pid IS NULL OR NEW.idempotency_key <> 'payout:' || v_pid || ':' || v_kind OR NOT EXISTS (
         SELECT 1 FROM payouts p WHERE p.id = v_pid AND NEW.id = CASE v_kind WHEN 'reserve' THEN p.reserve_entry WHEN 'settle' THEN p.settle_entry
                                                                           WHEN 'return' THEN p.return_entry ELSE p.reverse_entry END) THEN
      RAISE EXCEPTION 'ledger entry % touches payout accounts without a matching payout record', NEW.id USING ERRCODE = 'P0431'; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION payouts_guard() RETURNS trigger AS $$
DECLARE ok boolean; missing text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT string_agg(key, ',') INTO missing FROM accounting_policy
      WHERE key IN ('hold_days','coin_value_usd_micros','min_payout_coins','review_threshold_coins','clawback_mode') AND value IS NULL;
    IF missing IS NOT NULL THEN RAISE EXCEPTION 'policy_not_approved: %', missing USING ERRCODE = 'P0428'; END IF;
    IF NEW.status NOT IN ('pending_review','queued') OR NEW.provider_ref IS NOT NULL OR NEW.attempts <> 0 OR NEW.lease_until IS NOT NULL
       OR NEW.settle_entry IS NOT NULL OR NEW.return_entry IS NOT NULL OR NEW.reverse_entry IS NOT NULL THEN
      RAISE EXCEPTION 'payouts must be created as pending_review or queued with no provider reference or settlement' USING ERRCODE = 'P0435'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.amount_coins <> OLD.amount_coins OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.provider_account_id <> OLD.provider_account_id
     OR NEW.provider <> OLD.provider OR NEW.currency <> OLD.currency THEN
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
      IF NOT EXISTS (SELECT 1 FROM payout_provider_evidence ev
                      WHERE ev.payout_id = NEW.id AND ev.provider = NEW.provider AND ev.provider_ref = NEW.provider_ref
                        AND ev.amount_minor = NEW.amount_minor AND ev.currency = NEW.currency
                        AND (OLD.status <> 'needs_review' OR ev.source IN ('provider_lookup','provider_webhook'))) THEN
        RAISE EXCEPTION 'payout % cannot be marked paid without matching provider evidence (needs_review requires lookup evidence)', NEW.id USING ERRCODE = 'P0432'; END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP FUNCTION IF EXISTS entry_matches(bigint, text, text, bigint, text, bigint);

-- ===== 4. Chargebacks: verified event, bounded lookback, bounded holds, reconciliation record =====
CREATE TABLE IF NOT EXISTS chargeback_cases (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL UNIQUE REFERENCES webhook_events(id),
  purchase_entry bigint NOT NULL UNIQUE REFERENCES journal_entries(id),
  user_id text NOT NULL,
  coins bigint NOT NULL CHECK (coins > 0),
  wallet_balance bigint NOT NULL,
  unrecovered bigint NOT NULL CHECK (unrecovered >= 0),
  lookback_days int NOT NULL CHECK (lookback_days BETWEEN 1 AND 180),
  hold_count int NOT NULL CHECK (hold_count >= 0),
  holds_total bigint NOT NULL CHECK (holds_total >= 0),
  placed_by text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (holds_total <= unrecovered)               -- holds can never exceed the exposure they answer to
);
DROP TRIGGER IF EXISTS chargeback_cases_ro ON chargeback_cases;
CREATE TRIGGER chargeback_cases_ro BEFORE UPDATE OR DELETE ON chargeback_cases FOR EACH ROW EXECUTE FUNCTION no_mutation();
GRANT SELECT ON chargeback_cases TO xtc_app, xtc_admin, xtc_readonly;

ALTER TABLE payout_holds ADD COLUMN IF NOT EXISTS gift_entry bigint REFERENCES journal_entries(id);
ALTER TABLE payout_holds ADD COLUMN IF NOT EXISTS chargeback_case bigint;
ALTER TABLE payout_holds DROP CONSTRAINT IF EXISTS payout_holds_chargeback_case_fk;
ALTER TABLE payout_holds ADD CONSTRAINT payout_holds_chargeback_case_fk FOREIGN KEY (chargeback_case) REFERENCES chargeback_cases(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS payout_holds_gift ON payout_holds(gift_entry) WHERE gift_entry IS NOT NULL;

DROP FUNCTION IF EXISTS place_chargeback_holds(bigint, int);
CREATE OR REPLACE FUNCTION place_chargeback_holds(p_event bigint, p_lookback_days int DEFAULT 90) RETURNS int AS $$
DECLARE ev webhook_events; v_entry bigint; v_user text; v_coins bigint; v_wallet bigint; v_unrec bigint; v_left bigint; v_case bigint;
        g record; r record; take bigint; amt bigint; avail bigint; n int := 0; total bigint := 0; lp text;
BEGIN
  IF p_lookback_days IS NULL OR p_lookback_days < 1 OR p_lookback_days > 180 THEN
    RAISE EXCEPTION 'lookback must be between 1 and 180 days' USING ERRCODE = 'P0440'; END IF;
  SELECT * INTO ev FROM webhook_events WHERE id = p_event;
  IF NOT FOUND OR ev.kind <> 'chargeback' OR ev.provider_tx_id IS NULL THEN
    RAISE EXCEPTION 'no recorded chargeback event %', p_event USING ERRCODE = 'P0441'; END IF;
  lp := CASE WHEN ev.simulated THEN 'simulation' ELSE ev.ledger_provider END;
  SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'purchase:' || lp || ':' || ev.provider_tx_id AND type = 'purchase';
  IF v_entry IS NULL THEN RAISE EXCEPTION 'chargeback event % references no recorded purchase', p_event USING ERRCODE = 'P0441'; END IF;

  -- Chargebacks are rare; serializing placement makes the overlap and per-account caps exact.
  PERFORM pg_advisory_xact_lock(724002);
  IF EXISTS (SELECT 1 FROM chargeback_cases WHERE event_id = p_event OR purchase_entry = v_entry) THEN RETURN 0; END IF;

  SELECT a.owner_id, p.amount INTO v_user, v_coins FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
   WHERE p.entry_id = v_entry AND a.kind = 'user_wallet' AND p.amount > 0 LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'purchase entry % has no wallet credit', v_entry USING ERRCODE = 'P0441'; END IF;
  SELECT balance INTO v_wallet FROM ledger_accounts WHERE id = 'wallet:' || v_user;
  v_wallet := GREATEST(COALESCE(v_wallet, 0), 0);
  v_unrec := GREATEST(v_coins - v_wallet, 0);
  v_left := v_unrec;
  v_case := nextval('chargeback_cases_id_seq');

  FOR g IN SELECT e.id AS eid, -w.amount AS gross FROM postings w JOIN journal_entries e ON e.id = w.entry_id
            WHERE w.account_id = 'wallet:' || v_user AND w.role = 'gift_debit' AND w.amount < 0
              AND e.created_at > now() - make_interval(days => p_lookback_days)
              AND NOT EXISTS (SELECT 1 FROM journal_entries rv WHERE rv.reverses_entry = e.id)
              AND NOT EXISTS (SELECT 1 FROM payout_holds h WHERE h.gift_entry = e.id AND h.kind = 'chargeback')
            ORDER BY e.id DESC LOOP
    EXIT WHEN v_left <= 0;
    take := LEAST(v_left, g.gross);
    FOR r IN SELECT p.account_id, a.owner_id, p.amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
              WHERE p.entry_id = g.eid AND p.role IN ('creator_share','family_share') AND a.owner_id IS NOT NULL ORDER BY p.account_id LOOP
      amt := (take * r.amount) / g.gross;      -- floor: shares can under-hold by <1 coin each, never over-hold
      SELECT GREATEST(a.balance - COALESCE((SELECT sum(h.amount) FROM payout_holds h WHERE h.account_id = a.id AND h.status = 'active'), 0), 0)
        INTO avail FROM ledger_accounts a WHERE a.id = r.account_id;
      amt := LEAST(amt, COALESCE(avail, 0));
      IF amt > 0 THEN
        INSERT INTO payout_holds(user_id, account_id, kind, amount, ref, reason, created_by, gift_entry, chargeback_case)
        VALUES (r.owner_id, r.account_id, 'chargeback', amt, 'cb:' || v_entry || ':' || g.eid || ':' || r.account_id,
                'chargeback of entry ' || v_entry, 'system', g.eid, v_case);
        n := n + 1; total := total + amt;
      END IF;
    END LOOP;
    v_left := v_left - take;
  END LOOP;

  INSERT INTO chargeback_cases(id, event_id, purchase_entry, user_id, coins, wallet_balance, unrecovered, lookback_days, hold_count, holds_total)
  VALUES (v_case, p_event, v_entry, v_user, v_coins, v_wallet, v_unrec, p_lookback_days, n, total);
  RETURN n;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION place_chargeback_holds(bigint,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION place_chargeback_holds(bigint,int) TO xtc_app, xtc_admin;

-- System-only hold kinds, immutable amounts, and valid release/consume transitions.
-- SECURITY INVOKER on purpose: current_user is the real caller, so only the system SECURITY DEFINER functions
-- (owned by the migrator) can insert chargeback/refund holds; runtime and privileged non-superuser logins cannot.
CREATE OR REPLACE FUNCTION payout_holds_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('chargeback','refund') AND is_runtime_identity() THEN
    RAISE EXCEPTION '% holds can only be placed by the system functions', NEW.kind USING ERRCODE = 'P0443'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS payout_holds_insert_guard_trg ON payout_holds;
CREATE TRIGGER payout_holds_insert_guard_trg BEFORE INSERT ON payout_holds FOR EACH ROW EXECUTE FUNCTION payout_holds_insert_guard();

CREATE OR REPLACE FUNCTION payout_holds_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'chargeback' AND (NEW.chargeback_case IS NULL OR NEW.gift_entry IS NULL) THEN
      RAISE EXCEPTION 'chargeback holds must reference a chargeback case and gift entry' USING ERRCODE = 'P0443'; END IF;
    IF NEW.status <> 'active' THEN RAISE EXCEPTION 'holds are created active' USING ERRCODE = 'P0443'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount
     OR NEW.ref IS DISTINCT FROM OLD.ref OR NEW.gift_entry IS DISTINCT FROM OLD.gift_entry OR NEW.chargeback_case IS DISTINCT FROM OLD.chargeback_case THEN
    RAISE EXCEPTION 'hold identity and amount are immutable' USING ERRCODE = 'P0443'; END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status <> 'active' THEN RAISE EXCEPTION 'hold already %', OLD.status USING ERRCODE = 'P0443'; END IF;
    IF NEW.status = 'released' AND (NEW.released_by IS NULL OR NEW.released_at IS NULL) THEN
      RAISE EXCEPTION 'release requires released_by and released_at' USING ERRCODE = 'P0443'; END IF;
    IF NEW.status = 'consumed' AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = NEW.settled_entry AND j.type = 'reversal') THEN
      RAISE EXCEPTION 'consuming a hold requires the reversal ledger entry that absorbed it' USING ERRCODE = 'P0443'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS payout_holds_guard_trg ON payout_holds;
CREATE TRIGGER payout_holds_guard_trg BEFORE INSERT OR UPDATE ON payout_holds FOR EACH ROW EXECUTE FUNCTION payout_holds_guard();

-- ===== 5. Destructive-operation guards: identity-based, not settable flags =====
CREATE OR REPLACE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
  IF is_direct_member('xtc_migrator') THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'TRUNCATE of % is blocked for non-migrator identity %', TG_TABLE_NAME, session_user USING ERRCODE = 'P0450';
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries','postings','ledger_accounts','audit_log','payouts','payout_events','payout_provider_evidence',
                           'accounting_policy','accounting_policy_history','policy_proposals','payout_holds','payout_hold_events','ddl_audit','chargeback_cases'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS no_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ddl_guard() RETURNS event_trigger AS $$
BEGIN
  IF is_direct_member('xtc_migrator') THEN RETURN; END IF;
  RAISE EXCEPTION 'schema/trigger/function/privilege changes require the migrator identity (command: %, login: %)', tg_tag, session_user USING ERRCODE = 'P0451';
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
DO $$ BEGIN
  DROP EVENT TRIGGER IF EXISTS xtc_ddl_guard;
  CREATE EVENT TRIGGER xtc_ddl_guard ON ddl_command_start
    WHEN TAG IN ('ALTER TABLE','DROP TABLE','CREATE TRIGGER','DROP TRIGGER','ALTER TRIGGER','CREATE FUNCTION','DROP FUNCTION','ALTER FUNCTION',
                 'DROP SCHEMA','ALTER SCHEMA','CREATE POLICY','ALTER POLICY','DROP POLICY','GRANT','REVOKE','ALTER DEFAULT PRIVILEGES')
    EXECUTE FUNCTION ddl_guard();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'xtc_ddl_guard NOT (re)installed: superuser required (see docs/OPERATIONS.md)';
END $$;
