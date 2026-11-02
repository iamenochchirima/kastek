ALTER TABLE agents_platform.customer_conversations
  ALTER COLUMN deployment_id DROP NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN channel_kind text NOT NULL DEFAULT 'website' CHECK(channel_kind IN ('website','whatsapp','telegram','facebook','instagram')),
  ADD COLUMN channel_deployment_id uuid,
  ADD COLUMN external_conversation_id text,
  ADD COLUMN external_sender_id text,
  ADD FOREIGN KEY(organization_id,channel_deployment_id) REFERENCES agents_platform.channel_deployments(organization_id,id),
  ADD CHECK ((channel_kind='website' AND deployment_id IS NOT NULL AND session_id IS NOT NULL AND channel_deployment_id IS NULL
    AND external_conversation_id IS NULL AND external_sender_id IS NULL)
    OR (channel_kind<>'website' AND deployment_id IS NULL AND session_id IS NULL AND channel_deployment_id IS NOT NULL
    AND external_conversation_id IS NOT NULL AND external_sender_id IS NOT NULL
    AND length(external_conversation_id) BETWEEN 1 AND 512 AND length(external_sender_id) BETWEEN 1 AND 512));
CREATE UNIQUE INDEX customer_channel_conversation ON agents_platform.customer_conversations(channel_deployment_id,external_conversation_id)
  WHERE channel_deployment_id IS NOT NULL;
CREATE INDEX customer_channel_inbox ON agents_platform.customer_conversations(organization_id,channel_kind,updated_at DESC,id DESC);
CREATE OR REPLACE FUNCTION agents_platform.protect_customer_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.version_id IS DISTINCT FROM OLD.version_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.channel_kind IS DISTINCT FROM OLD.channel_kind
    OR NEW.channel_deployment_id IS DISTINCT FROM OLD.channel_deployment_id
    OR NEW.external_conversation_id IS DISTINCT FROM OLD.external_conversation_id
    OR NEW.external_sender_id IS DISTINCT FROM OLD.external_sender_id
    OR (NEW.execution_conversation_id IS DISTINCT FROM OLD.execution_conversation_id AND OLD.execution_conversation_id IS NOT NULL)
  THEN RAISE EXCEPTION 'Customer conversation binding is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
