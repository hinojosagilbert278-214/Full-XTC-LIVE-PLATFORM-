-- Restricted financial functions, debt accounts, wallet freezes. Idempotent.
-- Existing journal history is untouched; idempotency signatures keep the original TS format.

ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check CHECK (kind IN
  ('user_wallet','creator_earnings','family_earnings','platform_revenue','coin_issuance',
   'payment_clearing','payout_clearing','payouts_paid','creator_debt','user_debt','family_debt'));

-- Only contra/receivable kinds may ever be negative (a compromised writer cannot create an overdraftable wallet).
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS negative_only_for_contra;
ALTER TABLE ledger_accounts ADD CONSTRAINT negative_only_for_contra CHECK
  (NOT allow_negative OR kind IN ('coin_issuance','creator_debt','user_debt','family_debt'));

ALTER TABLE ledger_accounts ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false;

-- Runs with owner rights so the runtime role needs no UPDATE privilege on balances.
CREATE OR REPLACE FUNCTION apply_posting() RETURNS trigger AS $$
DECLARE is_frozen boolean;
BEGIN
  UPDATE ledger_accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id RETURNING frozen INTO is_frozen;
  IF is_frozen AND NEW.amount < 0 AND NEW.role NOT LIKE 'reversal:%' AND NEW.role NOT LIKE 'debt\_%' THEN
    RAISE EXCEPTION 'account_frozen' USING ERRCODE = 'P0423';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The only write path into journal_entries/postings for the runtime role.
CREATE OR REPLACE FUNCTION ledger_post_entry(p_key text, p_type text, p_postings jsonb, p_metadata jsonb, p_reverses bigint, p_sig text)
RETURNS TABLE(entry_id bigint, replayed boolean) AS $$
DECLARE v_id bigint; v_sig text; x record;
BEGIN
  IF jsonb_typeof(p_postings) <> 'array' OR jsonb_array_length(p_postings) < 2 THEN
    RAISE EXCEPTION 'entry needs at least two postings';
  END IF;
  INSERT INTO journal_entries(idempotency_key, type, reverses_entry, metadata)
  VALUES (p_key, p_type, p_reverses, COALESCE(p_metadata,'{}'::jsonb) || jsonb_build_object('sig', p_sig))
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id, metadata->>'sig' INTO v_id, v_sig FROM journal_entries WHERE idempotency_key = p_key;
    IF v_sig IS DISTINCT FROM p_sig THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0409';
    END IF;
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  -- Sorted account order avoids lock-order deadlocks between concurrent entries.
  FOR x IN SELECT t.account, t.amount, COALESCE(t.role,'primary') AS role
             FROM jsonb_to_recordset(p_postings) AS t(account text, amount bigint, role text) ORDER BY t.account LOOP
    INSERT INTO postings(entry_id, account_id, amount, role) VALUES (v_id, x.account, x.amount, x.role);
  END LOOP;
  RETURN QUERY SELECT v_id, false;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
