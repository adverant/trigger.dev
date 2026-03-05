-- Migration 011: Structured run logs table
-- Stores structured log entries from task executions

CREATE TABLE IF NOT EXISTS trigger.run_logs (
  log_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES trigger.run_history(run_id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  task_identifier VARCHAR(255),
  level           VARCHAR(10) NOT NULL CHECK (level IN ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR')),
  message         TEXT NOT NULL,
  data            JSONB,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_run_logs_run_id ON trigger.run_logs(run_id, timestamp ASC);
CREATE INDEX idx_run_logs_org_level ON trigger.run_logs(organization_id, level, timestamp DESC);
CREATE INDEX idx_run_logs_org_task ON trigger.run_logs(organization_id, task_identifier, timestamp DESC);
CREATE INDEX idx_run_logs_message_search ON trigger.run_logs USING GIN (to_tsvector('english', message));

ALTER TABLE trigger.run_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY run_logs_org_isolation ON trigger.run_logs
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
