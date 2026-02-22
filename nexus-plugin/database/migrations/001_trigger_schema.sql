-- Migration 001: Trigger.dev Plugin Schema
-- Creates all core tables for the Nexus Trigger.dev marketplace plugin

BEGIN;

-- Create trigger schema
CREATE SCHEMA IF NOT EXISTS trigger;

-- ============================================================================
-- Table: trigger.projects
-- Links a Nexus organization to a Trigger.dev project
-- ============================================================================
CREATE TABLE trigger.projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    user_id UUID NOT NULL,
    trigger_project_ref VARCHAR(255) NOT NULL,
    trigger_project_name VARCHAR(255),
    environment VARCHAR(50) NOT NULL CHECK (environment IN ('dev', 'staging', 'production')),
    api_key_encrypted TEXT,
    personal_access_token_encrypted TEXT,
    trigger_api_url VARCHAR(500) NOT NULL DEFAULT 'http://trigger-dev-webapp:3030',
    mode VARCHAR(20) NOT NULL CHECK (mode IN ('self-hosted', 'external')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, trigger_project_ref, environment)
);

-- ============================================================================
-- Table: trigger.task_definitions
-- Registered task definitions synced from Trigger.dev
-- ============================================================================
CREATE TABLE trigger.task_definitions (
    task_def_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES trigger.projects(project_id) ON DELETE CASCADE,
    organization_id UUID NOT NULL,
    task_identifier VARCHAR(255) NOT NULL,
    task_version VARCHAR(50),
    description TEXT,
    input_schema JSONB,
    retry_config JSONB,
    queue_name VARCHAR(255),
    machine_preset VARCHAR(50),
    is_nexus_integration BOOLEAN NOT NULL DEFAULT FALSE,
    nexus_service VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, task_identifier, task_version)
);

-- ============================================================================
-- Table: trigger.run_history
-- Records of every task run with full status tracking
-- ============================================================================
CREATE TABLE trigger.run_history (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger_run_id VARCHAR(255) NOT NULL,
    project_id UUID NOT NULL REFERENCES trigger.projects(project_id) ON DELETE CASCADE,
    organization_id UUID NOT NULL,
    task_identifier VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN (
        'QUEUED', 'EXECUTING', 'REATTEMPTING', 'FROZEN',
        'COMPLETED', 'CANCELED', 'FAILED', 'CRASHED',
        'INTERRUPTED', 'SYSTEM_FAILURE', 'EXPIRED',
        'DELAYED', 'WAITING_FOR_DEPLOY', 'TIMED_OUT', 'PENDING'
    )),
    payload JSONB,
    output JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    idempotency_key VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}',
    tags TEXT[] NOT NULL DEFAULT '{}',
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    graphrag_stored BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Table: trigger.schedule_configs
-- Cron-based schedule configurations for recurring tasks
-- ============================================================================
CREATE TABLE trigger.schedule_configs (
    schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger_schedule_id VARCHAR(255),
    project_id UUID NOT NULL REFERENCES trigger.projects(project_id) ON DELETE CASCADE,
    organization_id UUID NOT NULL,
    user_id UUID NOT NULL,
    task_identifier VARCHAR(255) NOT NULL,
    cron_expression VARCHAR(100) NOT NULL,
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    payload JSONB,
    external_id VARCHAR(255),
    last_run_at TIMESTAMPTZ,
    last_status VARCHAR(50),
    next_run_at TIMESTAMPTZ,
    run_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, task_identifier, cron_expression)
);

-- ============================================================================
-- Table: trigger.waitpoints
-- Human-in-the-loop and external event waitpoints
-- ============================================================================
CREATE TABLE trigger.waitpoints (
    waitpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id VARCHAR(255) NOT NULL UNIQUE,
    run_id UUID REFERENCES trigger.run_history(run_id) ON DELETE SET NULL,
    trigger_run_id VARCHAR(255),
    project_id UUID NOT NULL REFERENCES trigger.projects(project_id) ON DELETE CASCADE,
    organization_id UUID NOT NULL,
    task_identifier VARCHAR(255),
    description TEXT,
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'cancelled')),
    input JSONB,
    output JSONB,
    requested_by VARCHAR(255),
    completed_by VARCHAR(255),
    expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Table: trigger.webhooks
-- Outbound webhook subscriptions for event notifications
-- ============================================================================
CREATE TABLE trigger.webhooks (
    webhook_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES trigger.projects(project_id) ON DELETE CASCADE,
    organization_id UUID NOT NULL,
    url VARCHAR(500) NOT NULL,
    secret VARCHAR(255) NOT NULL,
    events TEXT[] NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_triggered_at TIMESTAMPTZ,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Table: trigger.usage_metrics
-- Per-event usage tracking for billing and analytics
-- ============================================================================
CREATE TABLE trigger.usage_metrics (
    metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    metric_type VARCHAR(50) NOT NULL CHECK (metric_type IN (
        'task_trigger', 'batch_trigger', 'schedule_run',
        'waitpoint_resolution', 'api_call', 'ws_connection'
    )),
    count INTEGER NOT NULL DEFAULT 1,
    metadata JSONB NOT NULL DEFAULT '{}',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- projects
CREATE INDEX idx_projects_organization_id ON trigger.projects(organization_id);
CREATE INDEX idx_projects_user_id ON trigger.projects(user_id);
CREATE INDEX idx_projects_trigger_project_ref ON trigger.projects(trigger_project_ref);

-- task_definitions
CREATE INDEX idx_task_definitions_project_id ON trigger.task_definitions(project_id);
CREATE INDEX idx_task_definitions_organization_id ON trigger.task_definitions(organization_id);
CREATE INDEX idx_task_definitions_task_identifier ON trigger.task_definitions(task_identifier);
CREATE INDEX idx_task_definitions_nexus_service ON trigger.task_definitions(nexus_service) WHERE nexus_service IS NOT NULL;

-- run_history
CREATE INDEX idx_run_history_trigger_run_id ON trigger.run_history(trigger_run_id);
CREATE INDEX idx_run_history_project_id ON trigger.run_history(project_id);
CREATE INDEX idx_run_history_organization_id ON trigger.run_history(organization_id);
CREATE INDEX idx_run_history_task_identifier ON trigger.run_history(task_identifier);
CREATE INDEX idx_run_history_status ON trigger.run_history(status);
CREATE INDEX idx_run_history_created_at ON trigger.run_history(created_at DESC);
CREATE INDEX idx_run_history_org_status ON trigger.run_history(organization_id, status);
CREATE INDEX idx_run_history_org_task ON trigger.run_history(organization_id, task_identifier);
CREATE INDEX idx_run_history_org_created ON trigger.run_history(organization_id, created_at DESC);
CREATE INDEX idx_run_history_idempotency_key ON trigger.run_history(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_run_history_graphrag_stored ON trigger.run_history(graphrag_stored) WHERE graphrag_stored = FALSE;
CREATE INDEX idx_run_history_metadata_gin ON trigger.run_history USING GIN (metadata);
CREATE INDEX idx_run_history_tags_gin ON trigger.run_history USING GIN (tags);

-- schedule_configs
CREATE INDEX idx_schedule_configs_project_id ON trigger.schedule_configs(project_id);
CREATE INDEX idx_schedule_configs_organization_id ON trigger.schedule_configs(organization_id);
CREATE INDEX idx_schedule_configs_task_identifier ON trigger.schedule_configs(task_identifier);
CREATE INDEX idx_schedule_configs_enabled ON trigger.schedule_configs(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_schedule_configs_next_run_at ON trigger.schedule_configs(next_run_at) WHERE enabled = TRUE;
CREATE INDEX idx_schedule_configs_trigger_schedule_id ON trigger.schedule_configs(trigger_schedule_id) WHERE trigger_schedule_id IS NOT NULL;

-- waitpoints
CREATE INDEX idx_waitpoints_run_id ON trigger.waitpoints(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_waitpoints_project_id ON trigger.waitpoints(project_id);
CREATE INDEX idx_waitpoints_organization_id ON trigger.waitpoints(organization_id);
CREATE INDEX idx_waitpoints_status ON trigger.waitpoints(status);
CREATE INDEX idx_waitpoints_org_status ON trigger.waitpoints(organization_id, status);
CREATE INDEX idx_waitpoints_trigger_run_id ON trigger.waitpoints(trigger_run_id) WHERE trigger_run_id IS NOT NULL;
CREATE INDEX idx_waitpoints_expires_at ON trigger.waitpoints(expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;

-- webhooks
CREATE INDEX idx_webhooks_project_id ON trigger.webhooks(project_id);
CREATE INDEX idx_webhooks_organization_id ON trigger.webhooks(organization_id);
CREATE INDEX idx_webhooks_active ON trigger.webhooks(active) WHERE active = TRUE;
CREATE INDEX idx_webhooks_events_gin ON trigger.webhooks USING GIN (events);

-- usage_metrics
CREATE INDEX idx_usage_metrics_organization_id ON trigger.usage_metrics(organization_id);
CREATE INDEX idx_usage_metrics_metric_type ON trigger.usage_metrics(metric_type);
CREATE INDEX idx_usage_metrics_recorded_at ON trigger.usage_metrics(recorded_at DESC);
CREATE INDEX idx_usage_metrics_org_type_recorded ON trigger.usage_metrics(organization_id, metric_type, recorded_at DESC);
CREATE INDEX idx_usage_metrics_metadata_gin ON trigger.usage_metrics USING GIN (metadata);

COMMIT;
