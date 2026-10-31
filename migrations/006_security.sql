-- Least-privilege roles, grants and RLS. Roles are NOLOGIN; credentials are provisioned out-of-band.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xtc_app') THEN CREATE ROLE xtc_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xtc_admin') THEN CREATE ROLE xtc_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xtc_readonly') THEN CREATE ROLE xtc_readonly NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xtc_authenticated') THEN CREATE ROLE xtc_authenticated NOLOGIN; END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, xtc_app, xtc_admin, xtc_readonly, xtc_authenticated;
REVOKE ALL ON FUNCTION ledger_post_entry(text,text,jsonb,jsonb,bigint,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO xtc_app, xtc_admin, xtc_readonly, xtc_authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO xtc_app, xtc_admin;

-- Runtime: writes ledger only via function; may create accounts (zero balance) but never edit balances.
GRANT EXECUTE ON FUNCTION ledger_post_entry(text,text,jsonb,jsonb,bigint,text) TO xtc_app, xtc_admin;
GRANT SELECT ON ledger_accounts, journal_entries, postings, ledger_discrepancies TO xtc_app, xtc_admin, xtc_readonly;
GRANT INSERT ON ledger_accounts TO xtc_app, xtc_admin;
GRANT SELECT, INSERT, UPDATE ON products, families, family_memberships, refund_requests, app_account_tokens, webhook_events TO xtc_app;
GRANT SELECT, INSERT ON audit_log, webhook_event_attempts TO xtc_app, xtc_admin;
GRANT SELECT ON audit_log, webhook_event_attempts, webhook_events, refund_requests TO xtc_readonly;
GRANT SELECT, UPDATE ON refund_requests TO xtc_admin;
GRANT UPDATE (frozen) ON ledger_accounts TO xtc_admin;

-- Frontend role: read-only, own rows only, enforced by RLS.
CREATE OR REPLACE FUNCTION auth_uid() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '') $$;
GRANT EXECUTE ON FUNCTION auth_uid() TO PUBLIC;

ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_accounts ON ledger_accounts;
CREATE POLICY own_accounts ON ledger_accounts FOR SELECT TO xtc_authenticated
  USING (id IN ('wallet:'||auth_uid(), 'earnings:'||auth_uid(), 'debt:user:'||auth_uid(), 'debt:creator:'||auth_uid()));
DROP POLICY IF EXISTS own_postings ON postings;
CREATE POLICY own_postings ON postings FOR SELECT TO xtc_authenticated
  USING (account_id IN ('wallet:'||auth_uid(), 'earnings:'||auth_uid()));
DROP POLICY IF EXISTS own_entries ON journal_entries;
CREATE POLICY own_entries ON journal_entries FOR SELECT TO xtc_authenticated
  USING (id IN (SELECT entry_id FROM postings WHERE account_id IN ('wallet:'||auth_uid(), 'earnings:'||auth_uid())));
-- Non-frontend roles keep full row visibility.
DROP POLICY IF EXISTS all_rows ON ledger_accounts;
CREATE POLICY all_rows ON ledger_accounts FOR ALL TO xtc_app, xtc_admin, xtc_readonly USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS all_rows ON postings;
CREATE POLICY all_rows ON postings FOR ALL TO xtc_app, xtc_admin, xtc_readonly USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS all_rows ON journal_entries;
CREATE POLICY all_rows ON journal_entries FOR ALL TO xtc_app, xtc_admin, xtc_readonly USING (true) WITH CHECK (true);
GRANT SELECT ON ledger_accounts, postings, journal_entries TO xtc_authenticated;
