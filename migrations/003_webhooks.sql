-- Webhook ingestion: persisted, deduplicated, asynchronously processed. Idempotent.

CREATE TABLE IF NOT EXISTS app_account_tokens (
  token   text PRIMARY KEY,           -- Apple appAccountToken / Google obfuscatedExternalAccountId set by our server at purchase time
  user_id text NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,                -- delivering channel: stripe|apple|google|revenuecat|simulation
  event_id        text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('purchase','refund','chargeback','ignore')),
  ledger_provider text,                         -- underlying store: stripe|apple|google (dedups across channels)
  provider_tx_id  text,
  user_ref        text,                         -- user id or account token, resolved at processing time
  sku             text,
  purchase_token  text,
  simulated       boolean NOT NULL DEFAULT false,
  raw_body        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','retrying','processed','ignored','needs_review','dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  entry_id        bigint REFERENCES journal_entries(id),
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_due_idx ON webhook_events(next_attempt_at) WHERE status IN ('pending','retrying','processing');

CREATE TABLE IF NOT EXISTS webhook_event_attempts (
  id       bigserial PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES webhook_events(id),
  attempt  integer NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  outcome  text NOT NULL,
  error    text
);
DROP TRIGGER IF EXISTS webhook_attempts_immutable ON webhook_event_attempts;
CREATE TRIGGER webhook_attempts_immutable BEFORE UPDATE OR DELETE ON webhook_event_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
