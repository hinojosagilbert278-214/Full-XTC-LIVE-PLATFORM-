-- Trust Blue Wallet: double-entry ledger. Idempotent (safe to reapply).
-- Convention: postings.amount is signed integer coins; every journal entry sums to 0.
-- Wallet-like accounts hold positive balances; coin_issuance is the contra account
-- (negative balance = total coins issued) and is the only kind allowed negative by default.

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id             text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN
                   ('user_wallet','creator_earnings','family_earnings','platform_revenue',
                    'coin_issuance','payment_clearing','payout_clearing')),
  owner_id       text,
  balance        bigint NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_negative_balance CHECK (allow_negative OR balance >= 0)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id              bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  type            text NOT NULL,
  reverses_entry  bigint REFERENCES journal_entries(id) UNIQUE,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postings (
  id         bigserial PRIMARY KEY,
  entry_id   bigint NOT NULL REFERENCES journal_entries(id),
  account_id text   NOT NULL REFERENCES ledger_accounts(id),
  amount     bigint NOT NULL CHECK (amount <> 0),
  role       text   NOT NULL DEFAULT 'primary'
);
CREATE INDEX IF NOT EXISTS postings_entry_idx ON postings(entry_id);
CREATE INDEX IF NOT EXISTS postings_account_idx ON postings(account_id);

-- Apply each posting to the cached balance atomically (row lock + CHECK constraint).
CREATE OR REPLACE FUNCTION apply_posting() RETURNS trigger AS $$
BEGIN
  UPDATE ledger_accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postings_apply ON postings;
CREATE TRIGGER postings_apply AFTER INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION apply_posting();

-- Every entry must balance at commit time.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(SUM(amount),0) INTO s FROM postings WHERE entry_id = NEW.entry_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance (sum=%)', NEW.entry_id, s;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postings_balanced ON postings;
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Immutability.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: ledger is append-only', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS postings_immutable ON postings;
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS journal_immutable ON journal_entries;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reconciliation view: cached balance vs. sum of postings.
CREATE OR REPLACE VIEW ledger_discrepancies AS
SELECT a.id, a.balance AS cached, COALESCE(SUM(p.amount),0) AS computed
FROM ledger_accounts a LEFT JOIN postings p ON p.account_id = a.id
GROUP BY a.id, a.balance
HAVING a.balance <> COALESCE(SUM(p.amount),0);
