-- Migration 005: Fix integration service URLs and seed missing services
-- Fixes empty/wrong URLs to match actual running K8s services.

BEGIN;

-- Fix existing rows with empty or wrong service_url
UPDATE trigger.integration_configs
SET service_url = 'http://nexus-graphrag:8090', enabled = true
WHERE service_name = 'graphrag' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%9000%');

UPDATE trigger.integration_configs
SET service_url = 'http://nexus-mageagent:8080', enabled = true
WHERE service_name = 'mageagent' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%9010%');

UPDATE trigger.integration_configs
SET service_url = 'http://nexus-fileprocess:9109', enabled = true
WHERE service_name = 'fileprocess' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%fileprocess%8080%');

UPDATE trigger.integration_configs
SET service_url = 'http://nexus-learningagent:8094', enabled = true
WHERE service_name = 'learningagent' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%learningagent%8080%');

UPDATE trigger.integration_configs
SET service_url = 'http://geoagent:9095', enabled = true
WHERE service_name = 'geoagent' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%geoagent%8080%');

UPDATE trigger.integration_configs
SET service_url = 'http://jupyterhub:8000', enabled = true
WHERE service_name = 'jupyter' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%jupyter-auth%');

UPDATE trigger.integration_configs
SET service_url = 'http://cvat-backend:8080', enabled = true
WHERE service_name = 'cvat' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%cvat-auth%');

UPDATE trigger.integration_configs
SET service_url = '', enabled = false
WHERE service_name = 'gpu-bridge' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%gpu-bridge%8090%');

UPDATE trigger.integration_configs
SET service_url = '', enabled = false
WHERE service_name = 'sandbox' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%sandbox%9080%');

UPDATE trigger.integration_configs
SET service_url = 'http://n8n-main:5678', enabled = true
WHERE service_name = 'n8n' AND (service_url IS NULL OR service_url = '' OR service_url LIKE '%nexus-n8n%');

-- Insert missing services for all existing organizations
INSERT INTO trigger.integration_configs (organization_id, service_name, enabled, service_url, health_status)
SELECT ic.organization_id, s.name, s.enabled, s.url, 'unknown'
FROM (
  SELECT DISTINCT organization_id FROM trigger.integration_configs
) ic
CROSS JOIN (
  VALUES
    ('graphrag'::text, 'http://nexus-graphrag:8090', true),
    ('mageagent', 'http://nexus-mageagent:8080', true),
    ('fileprocess', 'http://nexus-fileprocess:9109', true),
    ('learningagent', 'http://nexus-learningagent:8094', true),
    ('geoagent', 'http://geoagent:9095', true),
    ('jupyter', 'http://jupyterhub:8000', true),
    ('cvat', 'http://cvat-backend:8080', true),
    ('gpu-bridge', '', false),
    ('sandbox', '', false),
    ('n8n', 'http://n8n-main:5678', true)
) AS s(name, url, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM trigger.integration_configs
  WHERE organization_id = ic.organization_id AND service_name = s.name
);

COMMIT;
