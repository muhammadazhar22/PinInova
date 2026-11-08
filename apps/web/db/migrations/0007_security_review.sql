-- Fixes from the 2026-11-08 security review (docs/review-2026-11-08-security.md).

-- 1. OAuth state is bound to the browser that started it (nonce cookie) as well as to the user / consent link.
ALTER TABLE oauth_state ADD COLUMN IF NOT EXISTS nonce_hash bytea;
DELETE FROM oauth_state WHERE nonce_hash IS NULL;
ALTER TABLE oauth_state ALTER COLUMN nonce_hash SET NOT NULL;

-- 3. Metrics can never outlive their connection (org deletion cascades workspace → connection → metrics).
--    Purge still deletes explicitly; this closes the path where a connection row itself is deleted.
DELETE FROM account_metrics_daily m WHERE NOT EXISTS (SELECT 1 FROM pinterest_connection c WHERE c.id = m.connection_id);
DELETE FROM pin_metrics_daily m WHERE NOT EXISTS (SELECT 1 FROM pinterest_connection c WHERE c.id = m.connection_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_metrics_daily_conn_fk') THEN
    ALTER TABLE account_metrics_daily ADD CONSTRAINT account_metrics_daily_conn_fk
      FOREIGN KEY (connection_id) REFERENCES pinterest_connection(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pin_metrics_daily_conn_fk') THEN
    ALTER TABLE pin_metrics_daily ADD CONSTRAINT pin_metrics_daily_conn_fk
      FOREIGN KEY (connection_id) REFERENCES pinterest_connection(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 5. Alert e-mails name the account: tie them to the connection so purge removes them.
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES pinterest_connection(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION system_rows_for_connection(p_conn uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'account_metrics_daily', (SELECT count(*) FROM account_metrics_daily WHERE connection_id = p_conn),
    'pin_metrics_daily', (SELECT count(*) FROM pin_metrics_daily WHERE connection_id = p_conn),
    'pin_meta', (SELECT count(*) FROM pin_meta WHERE connection_id = p_conn),
    'incident', (SELECT count(*) FROM incident WHERE connection_id = p_conn),
    'issue', (SELECT count(*) FROM issue WHERE connection_id = p_conn),
    'check_result', (SELECT count(*) FROM check_result WHERE connection_id = p_conn),
    'health_snapshot', (SELECT count(*) FROM health_snapshot WHERE connection_id = p_conn),
    'report', (SELECT count(*) FROM report WHERE connection_id = p_conn),
    'traffic_leak_result', (SELECT count(*) FROM traffic_leak_result WHERE connection_id = p_conn),
    'pin_token', (SELECT count(*) FROM pin_token WHERE connection_id = p_conn),
    'order_attribution', (SELECT count(*) FROM order_attribution WHERE connection_id = p_conn),
    'observed_signal', (SELECT count(*) FROM observed_signal WHERE connection_id = p_conn),
    'email_outbox', (SELECT count(*) FROM email_outbox WHERE connection_id = p_conn),
    'tokens', (SELECT count(*) FROM pinterest_connection WHERE id = p_conn AND (access_token_ct IS NOT NULL OR refresh_token_ct IS NOT NULL OR wrapped_key IS NOT NULL))
  ) $$;

-- 6. Erasure: anonymise the erased user's audit actor across tenants (identifiers only; no data returned).
CREATE OR REPLACE FUNCTION system_anonymise_actor(p_user text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE audit_event SET actor = 'erased-user' WHERE actor = p_user; GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM email_outbox WHERE to_address = (SELECT email FROM "user" WHERE id = p_user);
  RETURN n;
END $$;

-- 9. Client-viewer access is granted through an e-mailed, single-use invitation (proves control of the address).
CREATE TABLE IF NOT EXISTS viewer_invite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  invited_by text,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE viewer_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE viewer_invite FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON viewer_invite;
CREATE POLICY tenant_isolation ON viewer_invite USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON viewer_invite TO pinpulse_app;

-- Accepts an invite by token hash for the signed-in user; returns the workspace id (or NULL).
CREATE OR REPLACE FUNCTION system_accept_viewer_invite(p_token_hash bytea, p_user text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ws uuid;
BEGIN
  UPDATE viewer_invite SET accepted_at = now(), accepted_by = p_user
   WHERE token_hash = p_token_hash AND accepted_at IS NULL AND expires_at > now()
   RETURNING workspace_id INTO ws;
  IF ws IS NULL THEN RETURN NULL; END IF;
  INSERT INTO workspace_access (workspace_id, user_id, role) VALUES (ws, p_user, 'client_viewer') ON CONFLICT DO NOTHING;
  INSERT INTO audit_event (org_id, workspace_id, actor, action, target)
    SELECT w.org_id, ws, p_user, 'viewer.accepted', p_user FROM workspace w WHERE w.id = ws;
  RETURN ws;
END $$;

-- 12. Public weather reports: one row per reporter per day, upserted without granting UPDATE/SELECT to the app role.
CREATE OR REPLACE FUNCTION system_upsert_weather_report(p_reporter bytea, p_niche text, p_onset date, p_symptoms text[], p_status text, p_day date)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO weather_report (reporter_hash, niche, onset_date, symptoms, status, report_date)
  VALUES (p_reporter, p_niche, p_onset, p_symptoms, p_status, p_day)
  ON CONFLICT (reporter_hash, report_date) DO UPDATE SET niche = EXCLUDED.niche, onset_date = EXCLUDED.onset_date,
    symptoms = EXCLUDED.symptoms, status = EXCLUDED.status $$;

-- 13. Retention covers every derived table, stale Pin metadata, sent e-mail and expired links.
CREATE OR REPLACE FUNCTION system_delete_derived_before(p_cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i int; r int; k int; h int; a int; s int; o int; t int; l int; e int; c int; pm int; v int;
BEGIN
  DELETE FROM incident WHERE detected_at < p_cutoff; GET DIAGNOSTICS i = ROW_COUNT;
  DELETE FROM report WHERE created_at < p_cutoff; GET DIAGNOSTICS r = ROW_COUNT;
  DELETE FROM check_result WHERE checked_at < p_cutoff; GET DIAGNOSTICS k = ROW_COUNT;
  DELETE FROM health_snapshot WHERE date < p_cutoff::date; GET DIAGNOSTICS h = ROW_COUNT;
  DELETE FROM alert WHERE created_at < p_cutoff; GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM issue WHERE last_seen < p_cutoff; GET DIAGNOSTICS s = ROW_COUNT;
  DELETE FROM observed_signal WHERE created_at < p_cutoff; GET DIAGNOSTICS o = ROW_COUNT;
  DELETE FROM traffic_leak_result WHERE created_at < p_cutoff; GET DIAGNOSTICS t = ROW_COUNT;
  DELETE FROM order_attribution WHERE created_at < p_cutoff; GET DIAGNOSTICS l = ROW_COUNT;
  -- Pin metadata not seen by a sync within the derived window belongs to deleted Pins.
  DELETE FROM pin_meta WHERE last_seen < p_cutoff; GET DIAGNOSTICS pm = ROW_COUNT;
  -- E-mail bodies are kept 30 days after sending (delivery debugging), unsent ones 30 days after creation.
  DELETE FROM email_outbox WHERE coalesce(sent_at, created_at) < now() - interval '30 days'; GET DIAGNOSTICS e = ROW_COUNT;
  DELETE FROM consent_request WHERE expires_at < now() - interval '30 days'; GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM viewer_invite WHERE expires_at < now() - interval '30 days'; GET DIAGNOSTICS v = ROW_COUNT;
  DELETE FROM oauth_state WHERE expires_at < now();
  RETURN jsonb_build_object('incident', i, 'report', r, 'check_result', k, 'health_snapshot', h, 'alert', a, 'issue', s,
    'observed_signal', o, 'traffic_leak_result', t, 'order_attribution', l, 'pin_meta', pm, 'email_outbox', e,
    'consent_request', c, 'viewer_invite', v);
END $$;

REVOKE ALL ON FUNCTION system_anonymise_actor(text), system_accept_viewer_invite(bytea, text),
  system_upsert_weather_report(bytea, text, date, text[], text, date), system_delete_derived_before(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_anonymise_actor(text), system_accept_viewer_invite(bytea, text),
  system_upsert_weather_report(bytea, text, date, text[], text, date), system_delete_derived_before(timestamptz),
  system_rows_for_connection(uuid) TO pinpulse_app;
