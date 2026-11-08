ALTER TABLE weather_report ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'drop' CHECK (status IN ('drop', 'normal'));
ALTER TABLE weather_report ADD COLUMN IF NOT EXISTS report_date date NOT NULL DEFAULT current_date;
ALTER TABLE weather_report DROP CONSTRAINT IF EXISTS weather_report_reporter_hash_onset_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS weather_one_per_day ON weather_report(reporter_hash, report_date);
CREATE INDEX IF NOT EXISTS weather_onset_idx ON weather_report(onset_date);
-- Weather reports are voluntary, pseudonymous and not Pinterest API data (policy: PA-06).
ALTER TABLE weather_report ENABLE ROW LEVEL SECURITY;
CREATE POLICY weather_insert ON weather_report FOR INSERT WITH CHECK (true);
-- Reads only through the aggregate function below; no row-level reads by the app.
CREATE OR REPLACE FUNCTION system_weather_windows(p_from date, p_to date, p_niche text)
RETURNS TABLE(date date, reports int, active_reporters int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH days AS (SELECT generate_series(p_from, p_to, interval '1 day')::date AS d)
  SELECT d,
    (SELECT count(DISTINCT reporter_hash)::int FROM weather_report w WHERE w.status = 'drop' AND w.onset_date BETWEEN d - 2 AND d + 2
       AND (p_niche IS NULL OR w.niche = p_niche)),
    (SELECT count(DISTINCT reporter_hash)::int FROM weather_report w WHERE w.report_date BETWEEN d - 14 AND d + 14
       AND (p_niche IS NULL OR w.niche = p_niche))
  FROM days ORDER BY d $$;
GRANT EXECUTE ON FUNCTION system_weather_windows(date, date, text) TO pinpulse_app;

-- Attribution helpers: workspace salt for pseudonymising order references.
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS salt bytea NOT NULL DEFAULT gen_random_bytes(16);
