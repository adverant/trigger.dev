-- Migration: 016_user_event_log
-- Purpose: Store user auth events for notification emails and daily digest

CREATE TABLE IF NOT EXISTS trigger.user_event_log (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  user_email TEXT NOT NULL,
  user_name TEXT,
  user_id TEXT,
  user_tier TEXT,
  oauth_provider TEXT,
  is_new_user BOOLEAN DEFAULT FALSE,
  ip_address TEXT,
  user_agent TEXT,
  geo_country TEXT,
  geo_city TEXT,
  geo_timezone TEXT,
  geo_isp TEXT,
  device_browser TEXT,
  device_os TEXT,
  device_type TEXT,
  metadata JSONB DEFAULT '{}',
  email_sent BOOLEAN DEFAULT FALSE,
  digest_included BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_event_log_created ON trigger.user_event_log (created_at);
CREATE INDEX IF NOT EXISTS idx_user_event_log_type ON trigger.user_event_log (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_user_event_log_user ON trigger.user_event_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_event_log_digest ON trigger.user_event_log (digest_included, created_at)
  WHERE digest_included = FALSE;
