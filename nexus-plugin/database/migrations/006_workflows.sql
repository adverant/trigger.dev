-- Migration 006: Workflow Definitions & Runs
-- Adds workflow persistence for the Nexus Workflows visual builder
-- Powered by Trigger.dev (https://trigger.dev)

BEGIN;

-- ============================================================================
-- Table: trigger.workflows
-- Saved workflow definitions (nodes, edges, config as JSONB)
-- ============================================================================
CREATE TABLE trigger.workflows (
    workflow_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    user_id         UUID NOT NULL,
    project_id      UUID REFERENCES trigger.projects(project_id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    -- Full visual graph: { nodes: [...], edges: [...], viewport: {...} }
    definition      JSONB NOT NULL DEFAULT '{}',
    version         INTEGER NOT NULL DEFAULT 1,
    is_template     BOOLEAN NOT NULL DEFAULT FALSE,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'archived')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name, version)
);

-- ============================================================================
-- Table: trigger.workflow_runs
-- Execution instances with universal nxj_ IDs
-- ============================================================================
CREATE TABLE trigger.workflow_runs (
    -- Universal job ID: nxj_<ulid>
    run_id              VARCHAR(40) PRIMARY KEY,
    workflow_id         UUID NOT NULL REFERENCES trigger.workflows(workflow_id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL,
    user_id             UUID NOT NULL,
    -- Frozen snapshot of workflow definition at execution time
    definition_snapshot JSONB NOT NULL,
    -- Override parameters for this run
    parameters          JSONB NOT NULL DEFAULT '{}',
    -- Aggregated status across all nodes
    status              VARCHAR(30) NOT NULL DEFAULT 'queued'
                        CHECK (status IN (
                            'queued', 'running', 'paused', 'waiting_approval',
                            'completed', 'failed', 'cancelled', 'timeout'
                        )),
    -- Aggregated progress 0-100
    progress            INTEGER NOT NULL DEFAULT 0,
    -- Per-node status and output: { nodeId: { status, output, error, startedAt, completedAt } }
    node_states         JSONB NOT NULL DEFAULT '{}',
    -- Final aggregated output
    output              JSONB,
    error_message       TEXT,
    -- Cross-system ID references for traceability
    trigger_run_ids     TEXT[] NOT NULL DEFAULT '{}',
    mageagent_job_ids   TEXT[] NOT NULL DEFAULT '{}',
    skill_job_ids       TEXT[] NOT NULL DEFAULT '{}',
    n8n_execution_ids   TEXT[] NOT NULL DEFAULT '{}',
    -- Timing
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    duration_ms         INTEGER,
    -- Metadata (trigger source, UI context, etc.)
    metadata            JSONB NOT NULL DEFAULT '{}',
    tags                TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Workflows
CREATE INDEX idx_workflows_org ON trigger.workflows(organization_id);
CREATE INDEX idx_workflows_user ON trigger.workflows(user_id);
CREATE INDEX idx_workflows_status ON trigger.workflows(status);
CREATE INDEX idx_workflows_tags ON trigger.workflows USING GIN (tags);
CREATE INDEX idx_workflows_templates ON trigger.workflows(is_template) WHERE is_template = TRUE;

-- Workflow runs
CREATE INDEX idx_workflow_runs_workflow ON trigger.workflow_runs(workflow_id);
CREATE INDEX idx_workflow_runs_org ON trigger.workflow_runs(organization_id);
CREATE INDEX idx_workflow_runs_user ON trigger.workflow_runs(user_id);
CREATE INDEX idx_workflow_runs_status ON trigger.workflow_runs(status);
CREATE INDEX idx_workflow_runs_created ON trigger.workflow_runs(created_at DESC);
CREATE INDEX idx_workflow_runs_trigger_ids ON trigger.workflow_runs USING GIN (trigger_run_ids);
CREATE INDEX idx_workflow_runs_tags ON trigger.workflow_runs USING GIN (tags);

-- ============================================================================
-- Auto-update trigger for workflows.updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION trigger.update_workflow_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_updated
    BEFORE UPDATE ON trigger.workflows
    FOR EACH ROW
    EXECUTE FUNCTION trigger.update_workflow_timestamp();

COMMIT;
