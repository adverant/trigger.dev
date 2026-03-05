-- Migration 013: Alert rules for notification dispatch

CREATE TABLE IF NOT EXISTS trigger.alert_rules (
  alert_rule_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL,
  name             TEXT NOT NULL,
  event_type       TEXT NOT NULL CHECK (event_type IN (
    'run.failed', 'run.completed', 'run.timed_out',
    'task.error_rate_threshold', 'schedule.missed'
  )),
  condition        JSONB NOT NULL DEFAULT '{}',
  channel          TEXT NOT NULL CHECK (channel IN ('webhook', 'email')),
  target           TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at    TIMESTAMPTZ,
  fire_count       INTEGER NOT NULL DEFAULT 0,
  cooldown_minutes INTEGER NOT NULL DEFAULT 5,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_rules_org ON trigger.alert_rules(organization_id);
CREATE INDEX idx_alert_rules_event ON trigger.alert_rules(organization_id, event_type, enabled)
  WHERE enabled = TRUE;

ALTER TABLE trigger.alert_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY alert_rules_org_isolation ON trigger.alert_rules
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
