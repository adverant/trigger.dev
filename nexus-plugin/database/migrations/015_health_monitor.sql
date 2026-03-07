-- 015_health_monitor.sql
-- Platform Health Monitor tables for scheduled health checks and AI remediation.

BEGIN;

-- Health check reports — one row per Task 1 execution
CREATE TABLE IF NOT EXISTS trigger.health_reports (
  report_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  overall_status  VARCHAR(20) NOT NULL CHECK (overall_status IN ('HEALTHY', 'DEGRADED', 'CRITICAL')),
  checks          JSONB NOT NULL DEFAULT '[]',
  summary         JSONB NOT NULL DEFAULT '{}',
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  issues_exceeding_baseline JSONB DEFAULT '[]',
  baseline_comparison       JSONB,
  triggered_remediation     BOOLEAN DEFAULT FALSE,
  remediation_report_id     UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_reports_timestamp
  ON trigger.health_reports (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_health_reports_status
  ON trigger.health_reports (overall_status);

-- Remediation reports — one row per Task 2 execution
CREATE TABLE IF NOT EXISTS trigger.remediation_reports (
  report_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  health_report_id  UUID NOT NULL REFERENCES trigger.health_reports(report_id),
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  markdown_report   TEXT NOT NULL DEFAULT '',
  xml_remediation   TEXT NOT NULL DEFAULT '',
  issue_count       INTEGER NOT NULL DEFAULT 0,
  model_used        VARCHAR(100),
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remediation_reports_health
  ON trigger.remediation_reports (health_report_id);
CREATE INDEX IF NOT EXISTS idx_remediation_reports_timestamp
  ON trigger.remediation_reports (timestamp DESC);

-- Rolling component health baselines for deviation detection
CREATE TABLE IF NOT EXISTS trigger.health_baselines (
  baseline_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component    VARCHAR(255) NOT NULL,
  category     VARCHAR(50)  NOT NULL,
  metric_name  VARCHAR(100) NOT NULL,
  metric_value NUMERIC      NOT NULL DEFAULT 0,
  recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_baselines_component
  ON trigger.health_baselines (component, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_baselines_age
  ON trigger.health_baselines (recorded_at);

-- Configurable thresholds (runtime-tunable without code changes)
CREATE TABLE IF NOT EXISTS trigger.health_thresholds (
  threshold_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threshold_key   VARCHAR(100) NOT NULL UNIQUE,
  threshold_value NUMERIC NOT NULL,
  description     TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default thresholds
INSERT INTO trigger.health_thresholds (threshold_key, threshold_value, description) VALUES
  ('pod_restart_threshold',      3,  'Pod restarts in check window before alerting'),
  ('service_latency_ms',      5000,  'Max acceptable health endpoint response time (ms)'),
  ('memory_usage_percent',      85,  'Pod memory usage percent threshold'),
  ('cpu_usage_percent',         80,  'Pod CPU usage percent threshold'),
  ('disk_usage_percent',        85,  'Node disk usage percent threshold'),
  ('cert_expiry_days',          14,  'Days before cert expiry to alert'),
  ('replica_deviation_percent', 50,  'Desired vs ready replica tolerance percent'),
  ('deviation_trigger_percent', 30,  'Baseline deviation percent to trigger remediation'),
  ('min_unhealthy_to_trigger',   2,  'Minimum unhealthy checks to trigger remediation')
ON CONFLICT (threshold_key) DO NOTHING;

-- Cleanup: prune baselines older than 48 hours
CREATE OR REPLACE FUNCTION trigger.prune_health_baselines() RETURNS void AS $$
BEGIN
  DELETE FROM trigger.health_baselines WHERE recorded_at < NOW() - INTERVAL '48 hours';
END;
$$ LANGUAGE plpgsql;

-- Cleanup: prune reports older than 30 days
CREATE OR REPLACE FUNCTION trigger.prune_health_reports() RETURNS void AS $$
BEGIN
  DELETE FROM trigger.remediation_reports WHERE timestamp < NOW() - INTERVAL '30 days';
  DELETE FROM trigger.health_reports      WHERE timestamp < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE trigger.health_reports      IS 'Platform health check results from scheduled monitoring task';
COMMENT ON TABLE trigger.remediation_reports IS 'AI-generated remediation analysis reports';
COMMENT ON TABLE trigger.health_baselines    IS 'Rolling window of component health metrics for baseline comparison';
COMMENT ON TABLE trigger.health_thresholds   IS 'Configurable thresholds for health check alerting';

COMMIT;
