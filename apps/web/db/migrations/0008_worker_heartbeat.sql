-- SPEC-072: worker heartbeat for /api/health/worker and the uptime monitor. Not workspace data: the table holds no
-- tenant rows. RLS is enabled with no policy, so the app role (non-owner) can reach it only through the two functions
-- below. Not FORCEd on purpose: the functions run as the owner and must work whether or not the owner has BYPASSRLS.
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  beat_at timestamptz NOT NULL,
  release text
);
ALTER TABLE worker_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION system_worker_beat(p_worker text, p_started timestamptz, p_release text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO worker_heartbeat(worker_id, started_at, beat_at, release) VALUES (p_worker, p_started, now(), p_release)
  ON CONFLICT (worker_id) DO UPDATE SET beat_at = now(), started_at = EXCLUDED.started_at, release = EXCLUDED.release;
  DELETE FROM worker_heartbeat WHERE beat_at < now() - interval '7 days';
$$;

CREATE OR REPLACE FUNCTION system_worker_last_beat() RETURNS TABLE(beat_at timestamptz, workers integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(beat_at), count(*)::int FROM worker_heartbeat WHERE beat_at > now() - interval '1 hour' $$;

REVOKE ALL ON FUNCTION system_worker_beat(text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION system_worker_last_beat() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_worker_beat(text, timestamptz, text) TO pinpulse_app;
GRANT EXECUTE ON FUNCTION system_worker_last_beat() TO pinpulse_app;
