-- Migration 003: RLS Policies, Views, Functions, and Grants
-- Enables Row-Level Security, creates analytics views, and sets up triggers

BEGIN;

-- ============================================================================
-- FUNCTION: update_updated_at_column
-- Automatically sets updated_at on row modification
-- ============================================================================
CREATE OR REPLACE FUNCTION trigger.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- UPDATED_AT TRIGGERS
-- ============================================================================
CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON trigger.projects
    FOR EACH ROW EXECUTE FUNCTION trigger.update_updated_at_column();

CREATE TRIGGER trg_task_definitions_updated_at
    BEFORE UPDATE ON trigger.task_definitions
    FOR EACH ROW EXECUTE FUNCTION trigger.update_updated_at_column();

CREATE TRIGGER trg_schedule_configs_updated_at
    BEFORE UPDATE ON trigger.schedule_configs
    FOR EACH ROW EXECUTE FUNCTION trigger.update_updated_at_column();

CREATE TRIGGER trg_webhooks_updated_at
    BEFORE UPDATE ON trigger.webhooks
    FOR EACH ROW EXECUTE FUNCTION trigger.update_updated_at_column();

CREATE TRIGGER trg_integration_configs_updated_at
    BEFORE UPDATE ON trigger.integration_configs
    FOR EACH ROW EXECUTE FUNCTION trigger.update_updated_at_column();

-- ============================================================================
-- ROW-LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE trigger.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.task_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.run_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.schedule_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.waitpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.usage_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger.integration_configs ENABLE ROW LEVEL SECURITY;

-- RLS Policies: scoped by organization_id using current_setting('app.current_organization_id')

-- projects
CREATE POLICY projects_org_isolation ON trigger.projects
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- task_definitions
CREATE POLICY task_definitions_org_isolation ON trigger.task_definitions
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- run_history
CREATE POLICY run_history_org_isolation ON trigger.run_history
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- schedule_configs
CREATE POLICY schedule_configs_org_isolation ON trigger.schedule_configs
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- waitpoints
CREATE POLICY waitpoints_org_isolation ON trigger.waitpoints
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- webhooks
CREATE POLICY webhooks_org_isolation ON trigger.webhooks
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- usage_metrics
CREATE POLICY usage_metrics_org_isolation ON trigger.usage_metrics
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- integration_configs
CREATE POLICY integration_configs_org_isolation ON trigger.integration_configs
    USING (organization_id::text = current_setting('app.current_organization_id', TRUE))
    WITH CHECK (organization_id::text = current_setting('app.current_organization_id', TRUE));

-- ============================================================================
-- VIEW: trigger.run_statistics
-- 30-day aggregated run statistics per task per organization
-- ============================================================================
CREATE OR REPLACE VIEW trigger.run_statistics AS
SELECT
    rh.organization_id,
    rh.task_identifier,
    COUNT(*) AS total_runs,
    COUNT(*) FILTER (WHERE rh.status = 'COMPLETED') AS completed_runs,
    COUNT(*) FILTER (WHERE rh.status = 'FAILED') AS failed_runs,
    COUNT(*) FILTER (WHERE rh.status = 'CRASHED') AS crashed_runs,
    COUNT(*) FILTER (WHERE rh.status = 'CANCELED') AS canceled_runs,
    COUNT(*) FILTER (WHERE rh.status = 'TIMED_OUT') AS timed_out_runs,
    COUNT(*) FILTER (WHERE rh.status = 'SYSTEM_FAILURE') AS system_failure_runs,
    ROUND(AVG(rh.duration_ms) FILTER (WHERE rh.duration_ms IS NOT NULL), 2) AS avg_duration_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY rh.duration_ms)
        FILTER (WHERE rh.duration_ms IS NOT NULL) AS p95_duration_ms,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY rh.duration_ms)
        FILTER (WHERE rh.duration_ms IS NOT NULL) AS p50_duration_ms,
    MIN(rh.created_at) AS first_run_at,
    MAX(rh.created_at) AS last_run_at,
    CASE
        WHEN COUNT(*) = 0 THEN 0
        ELSE ROUND(
            (COUNT(*) FILTER (WHERE rh.status = 'COMPLETED'))::NUMERIC / COUNT(*) * 100, 2
        )
    END AS success_rate_pct
FROM trigger.run_history rh
WHERE rh.created_at >= NOW() - INTERVAL '30 days'
GROUP BY rh.organization_id, rh.task_identifier;

-- ============================================================================
-- VIEW: trigger.schedule_health
-- Schedule reliability scoring based on success/failure rates
-- ============================================================================
CREATE OR REPLACE VIEW trigger.schedule_health AS
SELECT
    sc.schedule_id,
    sc.organization_id,
    sc.task_identifier,
    sc.cron_expression,
    sc.timezone,
    sc.enabled,
    sc.run_count,
    sc.success_count,
    sc.failure_count,
    sc.last_run_at,
    sc.last_status,
    sc.next_run_at,
    CASE
        WHEN sc.run_count = 0 THEN 'no_data'
        WHEN sc.run_count > 0 AND sc.failure_count = 0 THEN 'healthy'
        WHEN sc.success_count::NUMERIC / GREATEST(sc.run_count, 1) >= 0.95 THEN 'healthy'
        WHEN sc.success_count::NUMERIC / GREATEST(sc.run_count, 1) >= 0.80 THEN 'degraded'
        WHEN sc.success_count::NUMERIC / GREATEST(sc.run_count, 1) >= 0.50 THEN 'unhealthy'
        ELSE 'critical'
    END AS health_rating,
    CASE
        WHEN sc.run_count = 0 THEN 0
        ELSE ROUND(sc.success_count::NUMERIC / GREATEST(sc.run_count, 1) * 100, 2)
    END AS reliability_pct,
    CASE
        WHEN sc.last_run_at IS NULL THEN NULL
        ELSE NOW() - sc.last_run_at
    END AS time_since_last_run
FROM trigger.schedule_configs sc;

-- ============================================================================
-- GRANTS: nexus_app role
-- ============================================================================
DO $$
BEGIN
    -- Create role if it does not exist
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
        CREATE ROLE nexus_app;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA trigger TO nexus_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.projects TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.task_definitions TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.run_history TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.schedule_configs TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.waitpoints TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.webhooks TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.usage_metrics TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON trigger.integration_configs TO nexus_app;

GRANT SELECT ON trigger.run_statistics TO nexus_app;
GRANT SELECT ON trigger.schedule_health TO nexus_app;

COMMIT;
