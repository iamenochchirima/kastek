CREATE TABLE agents_platform.agent_transfers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  agent_id uuid NOT NULL,
  version_id uuid NOT NULL,
  initiated_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  target_email text NOT NULL CHECK (length(target_email) BETWEEN 3 AND 320),
  target_account_id uuid REFERENCES agents_platform.accounts(id),
  target_organization_id uuid REFERENCES agents_platform.organizations(id),
  created_agent_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents_platform.agents(organization_id, id),
  FOREIGN KEY (organization_id, version_id) REFERENCES agents_platform.agent_versions(organization_id, id),
  CHECK (expires_at > created_at),
  CHECK ((state = 'pending') = (settled_at IS NULL)),
  CHECK (state <> 'accepted' OR (target_account_id IS NOT NULL AND target_organization_id IS NOT NULL AND created_agent_id IS NOT NULL))
);

CREATE UNIQUE INDEX agent_transfers_pending_agent
  ON agents_platform.agent_transfers(agent_id)
  WHERE state = 'pending';

CREATE INDEX agent_transfers_target_email
  ON agents_platform.agent_transfers(lower(target_email), created_at DESC);

CREATE TABLE agents_platform.agent_transfer_sources (
  transfer_id uuid NOT NULL REFERENCES agents_platform.agent_transfers(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  title text NOT NULL,
  copied_source_id uuid,
  copied_revision_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'copied')),
  PRIMARY KEY (transfer_id, source_id),
  CHECK ((state = 'copied') = (copied_source_id IS NOT NULL AND copied_revision_id IS NOT NULL))
);
