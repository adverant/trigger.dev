-- Migration 008: Bridge workflow_runs → run_history
--
-- Adds workflow_run_id column to run_history so workflow executions
-- appear on the Runs page. Each completed workflow run creates a
-- single run_history entry representing the overall execution.

ALTER TABLE trigger.run_history
  ADD COLUMN IF NOT EXISTS workflow_run_id TEXT REFERENCES trigger.workflow_runs(run_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_run_history_workflow_run_id
  ON trigger.run_history (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
