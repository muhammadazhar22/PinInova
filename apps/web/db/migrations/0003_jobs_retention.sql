-- Job queue schema owned by the app role (pg-boss creates its own tables inside).
-- Job payloads carry identifiers only, never metrics or tokens.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    CREATE SCHEMA pgboss AUTHORIZATION pinpulse_app;
  END IF;
END $$;

ALTER TABLE deletion_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deletion_log USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

-- Raw API metrics older than the raw-retention cutoff are deleted across tenants by the
-- retention job (policy: PA-01). CSV-imported history follows the derived retention period.
CREATE OR REPLACE FUNCTION system_delete_metrics_before(p_raw_cutoff date, p_csv_cutoff date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a int; p int; c int;
BEGIN
  DELETE FROM account_metrics_daily WHERE source = 'api' AND date < p_raw_cutoff; GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM account_metrics_daily WHERE source = 'csv' AND date < p_csv_cutoff; GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM pin_metrics_daily WHERE date < p_raw_cutoff; GET DIAGNOSTICS p = ROW_COUNT;
  RETURN jsonb_build_object('account_api', a, 'account_csv', c, 'pin', p);
END $$;

CREATE OR REPLACE FUNCTION system_delete_derived_before(p_cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i int; r int; k int; h int; a int;
BEGIN
  DELETE FROM incident WHERE detected_at < p_cutoff; GET DIAGNOSTICS i = ROW_COUNT;
  DELETE FROM report WHERE created_at < p_cutoff; GET DIAGNOSTICS r = ROW_COUNT;
  DELETE FROM check_result WHERE checked_at < p_cutoff; GET DIAGNOSTICS k = ROW_COUNT;
  DELETE FROM health_snapshot WHERE date < p_cutoff::date; GET DIAGNOSTICS h = ROW_COUNT;
  DELETE FROM alert WHERE created_at < p_cutoff; GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM oauth_state WHERE expires_at < now();
  RETURN jsonb_build_object('incident', i, 'report', r, 'check_result', k, 'health_snapshot', h, 'alert', a);
END $$;

-- Verifies that a purged connection left no rows behind (used by the nightly assertion job).
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
    'tokens', (SELECT count(*) FROM pinterest_connection WHERE id = p_conn AND (access_token_ct IS NOT NULL OR refresh_token_ct IS NOT NULL))
  ) $$;

CREATE OR REPLACE FUNCTION system_purged_connections() RETURNS TABLE(connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM pinterest_connection WHERE status = 'purged' AND purged_at > now() - interval '7 days' $$;

REVOKE ALL ON FUNCTION system_delete_metrics_before(date, date), system_delete_derived_before(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pinpulse_app;
