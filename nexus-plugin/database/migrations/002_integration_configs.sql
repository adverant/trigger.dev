-- Migration 002: Integration Configs
-- Service integration configuration for each organization

BEGIN;

-- ============================================================================
-- Table: trigger.integration_configs
-- Per-org configuration for Nexus service integrations
-- ============================================================================
CREATE TABLE trigger.integration_configs (
    config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    service_name VARCHAR(100) NOT NULL CHECK (service_name IN (
        'graphrag', 'mageagent', 'fileprocess', 'learningagent',
        'geoagent', 'jupyter', 'cvat', 'gpu-bridge', 'sandbox', 'n8n',
        'skills-engine'
    )),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    service_url VARCHAR(500),
    config JSONB NOT NULL DEFAULT '{}',
    last_health_check TIMESTAMPTZ,
    health_status VARCHAR(20) NOT NULL CHECK (health_status IN (
        'healthy', 'degraded', 'unhealthy', 'unknown'
    )) DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, service_name)
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX idx_integration_configs_organization_id ON trigger.integration_configs(organization_id);
CREATE INDEX idx_integration_configs_service_name ON trigger.integration_configs(service_name);
CREATE INDEX idx_integration_configs_enabled ON trigger.integration_configs(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_integration_configs_health_status ON trigger.integration_configs(health_status);
CREATE INDEX idx_integration_configs_config_gin ON trigger.integration_configs USING GIN (config);

COMMIT;
