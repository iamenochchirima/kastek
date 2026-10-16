CREATE TABLE IF NOT EXISTS agent_operator_projections (
  projection_key TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_operator_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'acknowledged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_operator_notifications_status_idx
  ON agent_operator_notifications (status, created_at DESC);
