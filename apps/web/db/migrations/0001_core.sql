-- PinPulse core schema.
-- Tenancy: organization (Better Auth) -> workspace -> pinterest_connection.
-- Every workspace-scoped table carries workspace_id and is protected by row-level security
-- keyed on the transaction-local setting app.workspace_id. The application connects as
-- pinpulse_app, which does not own these tables, so RLS always applies to it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinpulse_app') THEN
    CREATE ROLE pinpulse_app LOGIN PASSWORD 'pinpulse_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_org_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.org_id', true), '') $$;

-- Workspaces ---------------------------------------------------------------------------------
CREATE TABLE workspace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'own' CHECK (kind IN ('own', 'client')),
  niche text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_org_idx ON workspace(org_id);
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_by_org ON workspace
  USING (org_id = app_org_id() OR id = app_workspace_id())
  WITH CHECK (org_id = app_org_id());

-- Client viewers: a user who may see exactly one workspace (agency client).
CREATE TABLE workspace_access (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('client_viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Pinterest connections and consent -------------------------------------------------------
CREATE TABLE pinterest_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('mock', 'live')),
  pinterest_user_id text NOT NULL,
  username text NOT NULL,
  account_type text,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'disconnected', 'purged')),
  -- envelope encryption: tokens encrypted with a per-connection data key, which is wrapped by a KEK
  wrapped_key bytea,
  kek_version text,
  access_token_ct bytea,
  refresh_token_ct bytea,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  refreshed_at timestamptz,
  needs_reauth_since timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  disconnect_reason text,
  purge_after timestamptz,
  purged_at timestamptz
);
CREATE UNIQUE INDEX connection_unique_active ON pinterest_connection(workspace_id, pinterest_user_id)
  WHERE status IN ('active', 'needs_reauth');
CREATE INDEX connection_ws_idx ON pinterest_connection(workspace_id);

CREATE TABLE consent_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_by text NOT NULL,
  client_email text,
  consent_text_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  pinterest_user_id text NOT NULL,
  pinterest_username text NOT NULL,
  scopes text[] NOT NULL,
  consent_text_version text NOT NULL,
  granted_via text NOT NULL CHECK (granted_via IN ('owner', 'client_link')),
  granted_by_user_id text,
  revoke_token_hash bytea UNIQUE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE oauth_state (
  state_hash bytea PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id text,
  consent_request_id uuid REFERENCES consent_request(id) ON DELETE CASCADE,
  redirect_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Metrics (policy: PA-01, PA-02) -----------------------------------------------------------
-- Numbers only. No titles, descriptions, images or board names are stored anywhere.
CREATE TABLE account_metrics_daily (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  date date NOT NULL,
  split_key text NOT NULL DEFAULT 'all',
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'csv')),
  impressions bigint,
  outbound_clicks bigint,
  pin_clicks bigint,
  saves bigint,
  data_status text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, date, split_key, source)
) PARTITION BY RANGE (date);

CREATE TABLE pin_metrics_daily (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  pin_id text NOT NULL,
  date date NOT NULL,
  impressions bigint,
  outbound_clicks bigint,
  pin_clicks bigint,
  saves bigint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, pin_id, date)
) PARTITION BY RANGE (date);

-- Monthly partitions; scripts/partitions.ts and the retention job keep them rolling.
CREATE OR REPLACE FUNCTION ensure_month_partitions(p_from date, p_to date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m date; nm date; t text;
BEGIN
  m := date_trunc('month', p_from)::date;
  WHILE m <= p_to LOOP
    nm := (m + interval '1 month')::date;
    FOREACH t IN ARRAY ARRAY['account_metrics_daily', 'pin_metrics_daily'] LOOP
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                     t || '_' || to_char(m, 'YYYYMM'), t, m, nm);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t || '_' || to_char(m, 'YYYYMM'));
    END LOOP;
    m := nm;
  END LOOP;
END $$;
-- 2 years back covers CSV imports of native exports (1.5 years); 3 months ahead.
SELECT ensure_month_partitions((now() - interval '25 months')::date, (now() + interval '3 months')::date);

CREATE TABLE pin_meta (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  pin_id text NOT NULL,
  pin_created_at timestamptz,
  board_id text,
  link text,
  link_domain text,
  has_link boolean NOT NULL DEFAULT false,
  ai_disclosure text[],
  duplicate_cluster int,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, pin_id)
);

-- Derived outputs ---------------------------------------------------------------------------
CREATE TABLE incident (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('warning', 'drop')),
  tier text NOT NULL CHECK (tier IN ('watch', 'drop_detected', 'action_needed', 'platform_broadcast')),
  onset_date date,
  warning_date date,
  effect double precision,
  p_value double precision,
  q_value double precision,
  methods_agree boolean,
  confidence text,
  shape text,
  top_cause text,
  result jsonb NOT NULL,
  detector_version text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved')),
  user_cause text,
  user_feedback_at timestamptz
);
CREATE UNIQUE INDEX incident_one_per_onset ON incident(connection_id, onset_date) WHERE onset_date IS NOT NULL;

CREATE TABLE issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source text NOT NULL CHECK (source IN ('pinterest', 'you', 'unknown')),
  severity text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  affected_count int NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'validating', 'passed', 'failed', 'resolved', 'suppressed', 'regressed')),
  validate_started_at timestamptz,
  UNIQUE (connection_id, kind)
);

CREATE TABLE check_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  url text NOT NULL,
  domain text NOT NULL,
  final_url text,
  hops jsonb NOT NULL DEFAULT '[]',
  http_status int,
  total_ms int,
  robots jsonb,
  title_match boolean,
  claimed boolean,
  error text,
  ua_mode text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX check_result_run_idx ON check_result(connection_id, run_id);

CREATE TABLE health_snapshot (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  date date NOT NULL,
  score int NOT NULL CHECK (score BETWEEN 0 AND 100),
  band text NOT NULL,
  subgrades jsonb NOT NULL,
  PRIMARY KEY (connection_id, date)
);

-- Alerts and notifications --------------------------------------------------------------------
CREATE TABLE alert_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  sensitivity double precision NOT NULL DEFAULT 0.5 CHECK (sensitivity > 0 AND sensitivity < 1),
  emails text[] NOT NULL DEFAULT '{}',
  slack_webhook_ct bytea,
  slack_wrapped_key bytea,
  slack_kek_version text,
  digest text NOT NULL DEFAULT 'immediate' CHECK (digest IN ('immediate', 'daily')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  incident_id uuid REFERENCES incident(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issue(id) ON DELETE CASCADE,
  tier text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'slack')),
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_error text,
  useful boolean,
  feedback_at timestamptz
);

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  to_address text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  transport text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text
);

-- Reports -------------------------------------------------------------------------------------
CREATE TABLE report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('monthly', 'evidence_pack')),
  period_start date,
  period_end date,
  incident_id uuid REFERENCES incident(id) ON DELETE SET NULL,
  html text NOT NULL,
  pdf bytea,
  share_token_hash bytea UNIQUE,
  share_expires_at timestamptz,
  white_label jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Attribution (mocked integrations; no PII) ------------------------------------------------------
CREATE TABLE traffic_leak_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('csv', 'mock')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  pinterest_outbound_clicks bigint,
  ga4_pinterest_sessions bigint,
  ga4_direct_sessions bigint,
  leak_ratio double precision,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pin_token (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  token text NOT NULL,
  pin_id text,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, token)
);

CREATE TABLE order_attribution (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  order_ref_hash bytea NOT NULL,
  token text,
  revenue numeric(14, 2) NOT NULL,
  currency text NOT NULL,
  ordered_at timestamptz,
  source text NOT NULL CHECK (source IN ('csv', 'mock')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, order_ref_hash)
);

-- Audit and deletion ------------------------------------------------------------------------------
CREATE TABLE audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text,
  workspace_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_idx ON audit_event(workspace_id, at DESC);

CREATE TABLE deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reason text NOT NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  rows_deleted jsonb
);

-- Not tenant data: voluntary user reports for the weather index (policy: PA-06) and billing.
CREATE TABLE weather_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_hash bytea NOT NULL,
  niche text NOT NULL,
  onset_date date NOT NULL,
  symptoms text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_hash, onset_date)
);

CREATE TABLE subscription (
  org_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'solo', 'pro', 'agency', 'canceled')),
  status text NOT NULL DEFAULT 'trialing',
  provider text NOT NULL DEFAULT 'simulated',
  provider_ref text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  extra_accounts int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_event (
  event_id text PRIMARY KEY,
  provider text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- Row-level security for every workspace-scoped table -----------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pinterest_connection', 'consent_request', 'consent_record', 'oauth_state', 'account_metrics_daily',
    'pin_metrics_daily', 'pin_meta', 'incident', 'issue', 'check_result', 'health_snapshot', 'alert_settings',
    'alert', 'report', 'traffic_leak_result', 'pin_token', 'order_attribution', 'workspace_access'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', t);
  END LOOP;
END $$;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;

-- email_outbox and audit_event: rows with a workspace are tenant-visible; system rows are not.
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_tenant ON email_outbox USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id IS NULL OR workspace_id = app_workspace_id());
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_event FOR SELECT USING (workspace_id = app_workspace_id() OR (workspace_id IS NULL AND org_id = app_org_id()));
CREATE POLICY audit_insert ON audit_event FOR INSERT WITH CHECK (true);

-- System functions (SECURITY DEFINER) for the few cross-tenant reads the scheduler needs.
-- They return identifiers only, never metrics or tokens.
CREATE OR REPLACE FUNCTION system_connections_to_sync() RETURNS TABLE(connection_id uuid, workspace_id uuid, org_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.workspace_id, w.org_id FROM pinterest_connection c JOIN workspace w ON w.id = c.workspace_id
  WHERE c.status = 'active' $$;

CREATE OR REPLACE FUNCTION system_connections_to_purge(p_grace_days int) RETURNS TABLE(connection_id uuid, workspace_id uuid, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, workspace_id, status FROM pinterest_connection
  WHERE (status = 'disconnected' AND purge_after <= now())
     OR (status = 'needs_reauth' AND needs_reauth_since <= now() - make_interval(days => p_grace_days)) $$;

CREATE OR REPLACE FUNCTION system_connections_needing_refresh(p_before timestamptz) RETURNS TABLE(connection_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, workspace_id FROM pinterest_connection WHERE status = 'active' AND access_expires_at <= p_before $$;

CREATE OR REPLACE FUNCTION system_workspace_of_consent_token(p_hash bytea) RETURNS TABLE(consent_request_id uuid, workspace_id uuid, workspace_name text, org_name text, expires_at timestamptz, used_at timestamptz, consent_text_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.workspace_id, w.name, o.name, r.expires_at, r.used_at, r.consent_text_version
  FROM consent_request r JOIN workspace w ON w.id = r.workspace_id JOIN organization o ON o.id = w.org_id
  WHERE r.token_hash = p_hash $$;

CREATE OR REPLACE FUNCTION system_workspace_of_oauth_state(p_hash bytea) RETURNS TABLE(workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT workspace_id FROM oauth_state WHERE state_hash = p_hash AND expires_at > now() $$;

CREATE OR REPLACE FUNCTION system_workspace_of_revoke_token(p_hash bytea) RETURNS TABLE(workspace_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT workspace_id, connection_id FROM consent_record WHERE revoke_token_hash = p_hash AND revoked_at IS NULL $$;

CREATE OR REPLACE FUNCTION system_workspace_of_share_token(p_hash bytea) RETURNS TABLE(workspace_id uuid, report_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT workspace_id, id FROM report WHERE share_token_hash = p_hash AND (share_expires_at IS NULL OR share_expires_at > now()) $$;

CREATE OR REPLACE FUNCTION system_drop_metric_partitions_before(p_cutoff date) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname IN ('account_metrics_daily', 'pin_metrics_daily')
      AND to_date(right(c.relname, 6), 'YYYYMM') + interval '1 month' <= p_cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname); n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION system_drop_metric_partitions_before(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_drop_metric_partitions_before(date) TO pinpulse_app;
REVOKE ALL ON FUNCTION ensure_month_partitions(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_month_partitions(date, date) TO pinpulse_app;

GRANT USAGE ON SCHEMA public TO pinpulse_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pinpulse_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pinpulse_app;
