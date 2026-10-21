CREATE TABLE agents_platform.channel_ingress (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 512),
  digest text NOT NULL,
  event jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed','quarantined')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_id uuid,
  reason text,
  message_id uuid REFERENCES agents_platform.customer_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  FOREIGN KEY(organization_id,deployment_id) REFERENCES agents_platform.channel_deployments(organization_id,id),
  UNIQUE(connection_id,event_id)
);
CREATE INDEX channel_ingress_pending ON agents_platform.channel_ingress(available_at,id) WHERE state IN ('pending','processing');
CREATE TABLE agents_platform.channel_message_facts (
  message_id uuid PRIMARY KEY REFERENCES agents_platform.customer_messages(id),
  connection_id uuid NOT NULL REFERENCES agents_platform.channel_connections(id),
  provider_message_id text,
  provider_occurred_at timestamptz,
  reply_to_provider_message_id text,
  attachments jsonb NOT NULL DEFAULT '[]',
  UNIQUE(connection_id,provider_message_id)
);
CREATE TABLE agents_platform.channel_outbound (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES agents_platform.customer_conversations(id),
  message_id uuid NOT NULL REFERENCES agents_platform.customer_messages(id),
  segment integer NOT NULL CHECK(segment>=0),
  ownership_generation bigint NOT NULL,
  connection_revision integer NOT NULL,
  credential_revision integer NOT NULL,
  request jsonb NOT NULL,
  digest text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','sent','delivered','read','failed','unknown','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_id uuid,
  lease_until timestamptz,
  provider_message_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  FOREIGN KEY(organization_id,deployment_id) REFERENCES agents_platform.channel_deployments(organization_id,id),
  UNIQUE(message_id,segment), UNIQUE(connection_id,provider_message_id)
);
CREATE INDEX channel_outbound_pending ON agents_platform.channel_outbound(available_at,id) WHERE state IN ('pending','sending');
CREATE TABLE agents_platform.channel_receipts (
  connection_id uuid NOT NULL REFERENCES agents_platform.channel_connections(id),
  event_id text NOT NULL,
  provider_message_id text,
  external_conversation_id text NOT NULL,
  status text NOT NULL,
  provider_occurred_at timestamptz,
  watermark timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,event_id)
);
CREATE INDEX channel_receipt_message ON agents_platform.channel_receipts(connection_id,provider_message_id);
