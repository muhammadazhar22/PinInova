-- Narrow lookups used by authorization code before a tenant context exists.
CREATE OR REPLACE FUNCTION system_workspace_org(p_ws uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT org_id FROM workspace WHERE id = p_ws $$;

CREATE OR REPLACE FUNCTION system_client_workspaces(p_user text) RETURNS TABLE(workspace_id uuid, workspace_name text, org_id text, org_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.id, w.name, w.org_id, o.name FROM workspace_access a
  JOIN workspace w ON w.id = a.workspace_id JOIN organization o ON o.id = w.org_id
  WHERE a.user_id = p_user $$;

CREATE OR REPLACE FUNCTION system_has_workspace_access(p_ws uuid, p_user text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM workspace_access WHERE workspace_id = p_ws AND user_id = p_user $$;

-- Count connected accounts per org for plan limits (identifiers only).
CREATE OR REPLACE FUNCTION system_org_active_accounts(p_org text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM pinterest_connection c JOIN workspace w ON w.id = c.workspace_id
  WHERE w.org_id = p_org AND c.status IN ('active', 'needs_reauth') $$;

-- Org id for a workspace, for workers that only know the workspace.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pinpulse_app;
