-- Migration 012: Batches table for grouped task triggers

CREATE TABLE IF NOT EXISTS trigger.batches (
  batch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  name            TEXT,
  total_runs      INTEGER NOT NULL DEFAULT 0,
  completed_runs  INTEGER NOT NULL DEFAULT 0,
  failed_runs     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'partial_failure', 'failed')),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_batches_org ON trigger.batches(organization_id, created_at DESC);
CREATE INDEX idx_batches_status ON trigger.batches(organization_id, status);

ALTER TABLE trigger.batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY batches_org_isolation ON trigger.batches
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Add batch_id column to run_history for linking
ALTER TABLE trigger.run_history ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES trigger.batches(batch_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_run_history_batch_id ON trigger.run_history(batch_id) WHERE batch_id IS NOT NULL;
