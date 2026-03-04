-- Migration 007: Force RLS for table owner + system bypass policies
-- Without FORCE ROW LEVEL SECURITY, the table owner (nexus) bypasses RLS entirely.
-- This migration:
--   1. Forces RLS on all trigger tables (so owner role is also subject to policies)
--   2. Adds system bypass policies that allow full access when app.current_organization_id is not set
--   3. Keeps existing org_isolation policies for when the context IS set

BEGIN;

-- ============================================================================
-- FORCE RLS on all tables (applies to table owner too)
-- ============================================================================
ALTER TABLE trigger.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.task_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.run_history FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.schedule_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.waitpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.webhooks FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.usage_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.integration_configs FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- Update policies: allow access when no org context set (system operations),
-- restrict to org when context IS set
-- ============================================================================

-- Drop existing single-mode policies
DROP POLICY IF EXISTS projects_org_isolation ON trigger.projects;
DROP POLICY IF EXISTS task_definitions_org_isolation ON trigger.task_definitions;
DROP POLICY IF EXISTS run_history_org_isolation ON trigger.run_history;
DROP POLICY IF EXISTS schedule_configs_org_isolation ON trigger.schedule_configs;
DROP POLICY IF EXISTS waitpoints_org_isolation ON trigger.waitpoints;
DROP POLICY IF EXISTS webhooks_org_isolation ON trigger.webhooks;
DROP POLICY IF EXISTS usage_metrics_org_isolation ON trigger.usage_metrics;
DROP POLICY IF EXISTS integration_configs_org_isolation ON trigger.integration_configs;

-- Recreate with dual-mode: system bypass when context empty, org filter when set
CREATE POLICY projects_org_isolation ON trigger.projects
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY task_definitions_org_isolation ON trigger.task_definitions
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY run_history_org_isolation ON trigger.run_history
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY schedule_configs_org_isolation ON trigger.schedule_configs
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY waitpoints_org_isolation ON trigger.waitpoints
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY webhooks_org_isolation ON trigger.webhooks
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY usage_metrics_org_isolation ON trigger.usage_metrics
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY integration_configs_org_isolation ON trigger.integration_configs
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

-- Force RLS on workflow tables too (added in migration 006)
ALTER TABLE trigger.workflows FORCE ROW LEVEL SECURITY;
ALTER TABLE trigger.workflow_runs FORCE ROW LEVEL SECURITY;

-- Enable + force RLS on workflow tables
ALTER TABLE trigger.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflows_org_isolation ON trigger.workflows
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

CREATE POLICY workflow_runs_org_isolation ON trigger.workflow_runs
    USING (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    )
    WITH CHECK (
        current_setting('app.current_organization_id', TRUE) = ''
        OR organization_id::text = current_setting('app.current_organization_id', TRUE)
    );

COMMIT;
