CREATE TABLE agents_platform.customer_followup_preferences (
  conversation_id uuid PRIMARY KEY REFERENCES agents_platform.customer_conversations(id),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  purpose text NOT NULL CHECK (purpose = 'human_reply_notification'),
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'revoked')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_at timestamptz NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  CHECK ((status = 'verified') = (verified_at IS NOT NULL AND revoked_at IS NULL))
);

CREATE TABLE agents_platform.customer_followup_challenges (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  preference_revision bigint NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'return_to_conversation')),
  notification_id uuid,
  secret_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_followup_challenge_expiry ON agents_platform.customer_followup_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE agents_platform.customer_followup_access (
  session_id uuid PRIMARY KEY REFERENCES agents_platform.website_sessions(id),
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  deployment_id uuid NOT NULL REFERENCES agents_platform.website_deployments(id),
  preference_revision bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents_platform.customer_followup_notifications (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  message_id uuid NOT NULL REFERENCES agents_platform.customer_messages(id),
  preference_revision bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'sending', 'accepted', 'rejected', 'unknown', 'suppressed')),
  provider_id text,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, preference_revision)
);
CREATE TABLE agents_platform.customer_followup_reads (
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  session_id uuid NOT NULL REFERENCES agents_platform.website_sessions(id),
  sequence bigint NOT NULL CHECK(sequence > 0),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,session_id)
);
ALTER TABLE agents_platform.customer_followup_challenges ADD CONSTRAINT customer_followup_challenge_notification_fk
  FOREIGN KEY(notification_id) REFERENCES agents_platform.customer_followup_notifications(id);
ALTER TABLE agents_platform.customer_followup_challenges ADD CONSTRAINT customer_followup_challenge_purpose_scope
  CHECK ((purpose = 'verify_email' AND notification_id IS NULL) OR (purpose = 'return_to_conversation' AND notification_id IS NOT NULL));

CREATE TABLE agents_platform.customer_followup_runtime (
  instance_id uuid PRIMARY KEY,
  configuration_digest text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_followup_runtime_readiness ON agents_platform.customer_followup_runtime(configuration_digest,observed_at);
