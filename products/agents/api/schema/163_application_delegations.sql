CREATE TABLE agents_platform.application_signing_keys (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  public_key text NOT NULL CHECK (length(public_key) BETWEEN 32 AND 4096),
  algorithm text NOT NULL CHECK (algorithm = 'ed25519'),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, application_id) REFERENCES agents_platform.applications(organization_id, id)
);
CREATE INDEX application_signing_keys_active ON agents_platform.application_signing_keys(application_id) WHERE revoked_at IS NULL;

CREATE TABLE agents_platform.application_delegations (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  assertion_digest text NOT NULL CHECK (assertion_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, application_id) REFERENCES agents_platform.applications(organization_id, id)
);
