-- Migration 010: Error aggregation indexes
-- Enables fast error grouping and timeline queries on run_history

CREATE INDEX IF NOT EXISTS idx_run_history_error_status
  ON trigger.run_history (organization_id, status, created_at DESC)
  WHERE status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT');

CREATE INDEX IF NOT EXISTS idx_run_history_error_fingerprint
  ON trigger.run_history (organization_id, md5(COALESCE(error_message, '')))
  WHERE status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT');
