ALTER TABLE pinterest_connection ADD COLUMN IF NOT EXISTS claimed_sites jsonb NOT NULL DEFAULT '[]';
ALTER TABLE pinterest_connection ADD COLUMN IF NOT EXISTS sync_stats jsonb NOT NULL DEFAULT '{}';
-- Users can tell us what they observed in Pinterest's UI (we never scrape it): Visit-site demotion,
-- "blocked" link errors, AI labels. These feed the classifier as user-reported signals.
CREATE TABLE IF NOT EXISTS observed_signal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES pinterest_connection(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('visit_site_demoted', 'domain_block_error', 'ai_label', 'search_invisible')),
  note text,
  observed_on date NOT NULL DEFAULT current_date,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE observed_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE observed_signal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON observed_signal USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON observed_signal TO pinpulse_app;
