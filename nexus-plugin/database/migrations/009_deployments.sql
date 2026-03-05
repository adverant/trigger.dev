-- Migration 009: Deployments table
--
-- Tracks versioned snapshots of task code deployed to worker environments.
-- Each deployment bundles a set of task definitions at specific versions,
-- similar to a code release in Trigger.dev.

CREATE TABLE IF NOT EXISTS trigger.deployments (
  deployment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  project_id      UUID,
  version         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'superseded', 'failed', 'deploying', 'rolled_back')),
  environment     TEXT NOT NULL DEFAULT 'production',
  task_count      INTEGER NOT NULL DEFAULT 0,
  deployed_by     TEXT,
  changelog       TEXT,
  promoted_at     TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}',
  deployed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for listing deployments by org (most common query)
CREATE INDEX IF NOT EXISTS idx_deployments_org_deployed
  ON trigger.deployments (organization_id, deployed_at DESC);

-- Index for finding active deployment quickly
CREATE INDEX IF NOT EXISTS idx_deployments_org_status
  ON trigger.deployments (organization_id, status)
  WHERE status = 'active';

-- Enable RLS
ALTER TABLE trigger.deployments ENABLE ROW LEVEL SECURITY;

-- RLS policy: org-scoped access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'deployments' AND schemaname = 'trigger' AND policyname = 'deployments_org_isolation'
  ) THEN
    CREATE POLICY deployments_org_isolation ON trigger.deployments
      USING (
        organization_id::text = current_setting('app.current_organization_id', true)
        OR current_setting('app.current_organization_id', true) IS NULL
        OR current_setting('app.current_organization_id', true) = ''
      );
  END IF;
END $$;
