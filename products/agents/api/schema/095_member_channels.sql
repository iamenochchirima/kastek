CREATE TABLE agents_platform.member_channel_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL,
  credential_revision integer NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  state text NOT NULL CHECK(state IN ('challenge','pending','active','revoked')),
  challenge_hash text UNIQUE,
  expires_at timestamptz NOT NULL,
  sender_id text,
  chat_id text,
  sender_label text,
  conversation_id uuid,
  latest_inbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  FOREIGN KEY(organization_id,account_id) REFERENCES agents_platform.memberships(organization_id,account_id),
  FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.conversations(organization_id,id),
  UNIQUE(organization_id,id),
  CHECK(state NOT IN ('pending','active') OR (sender_id IS NOT NULL AND chat_id IS NOT NULL))
);
CREATE UNIQUE INDEX member_channel_active_sender ON agents_platform.member_channel_links(connection_id,sender_id) WHERE state IN ('pending','active');
CREATE INDEX member_channel_route ON agents_platform.member_channel_links(connection_id,chat_id,created_at DESC);
CREATE TABLE agents_platform.member_channel_tasks (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  organization_id uuid NOT NULL,
  link_id uuid NOT NULL,
  link_generation integer NOT NULL,
  ingress_id uuid NOT NULL UNIQUE REFERENCES agents_platform.channel_ingress(id),
  collected boolean NOT NULL DEFAULT false,
  FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
  FOREIGN KEY(organization_id,link_id) REFERENCES agents_platform.member_channel_links(organization_id,id)
);
ALTER TABLE agents_platform.channel_ingress ALTER COLUMN deployment_id DROP NOT NULL;
ALTER TABLE agents_platform.channel_ingress ADD COLUMN member_link_id uuid REFERENCES agents_platform.member_channel_links(id);
ALTER TABLE agents_platform.channel_ingress ADD CONSTRAINT channel_ingress_purpose CHECK(deployment_id IS NOT NULL OR member_link_id IS NOT NULL);
ALTER TABLE agents_platform.channel_outbound ALTER COLUMN deployment_id DROP NOT NULL;
ALTER TABLE agents_platform.channel_outbound ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE agents_platform.channel_outbound ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE agents_platform.channel_outbound ADD COLUMN member_link_id uuid REFERENCES agents_platform.member_channel_links(id);
ALTER TABLE agents_platform.channel_outbound ADD COLUMN member_task_id uuid REFERENCES agents_platform.tasks(id);
ALTER TABLE agents_platform.channel_outbound ADD COLUMN member_notice_key text;
ALTER TABLE agents_platform.channel_outbound ADD CONSTRAINT channel_outbound_purpose CHECK(
  (member_link_id IS NULL AND member_task_id IS NULL AND member_notice_key IS NULL AND deployment_id IS NOT NULL AND conversation_id IS NOT NULL AND message_id IS NOT NULL)
  OR (member_link_id IS NOT NULL AND member_notice_key IS NOT NULL AND deployment_id IS NULL AND conversation_id IS NULL AND message_id IS NULL));
CREATE UNIQUE INDEX member_channel_outbound_notice ON agents_platform.channel_outbound(member_link_id,member_notice_key,segment) WHERE member_link_id IS NOT NULL;

ALTER TABLE agents_platform.channel_ingress ADD FOREIGN KEY(organization_id,member_link_id) REFERENCES agents_platform.member_channel_links(organization_id,id);
ALTER TABLE agents_platform.channel_outbound ADD FOREIGN KEY(organization_id,member_link_id) REFERENCES agents_platform.member_channel_links(organization_id,id);
ALTER TABLE agents_platform.channel_outbound ADD FOREIGN KEY(organization_id,member_task_id) REFERENCES agents_platform.tasks(organization_id,id);

-- Revocation survives later membership restoration or provider reconnection.
CREATE FUNCTION agents_platform.revoke_member_channel_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='revoked' AND OLD.state<>'revoked' THEN
    UPDATE agents_platform.execution_grants SET revoked_at=coalesce(revoked_at,now())
      WHERE id IN (SELECT t.grant_id FROM agents_platform.tasks t JOIN agents_platform.member_channel_tasks m ON m.task_id=t.id WHERE m.link_id=NEW.id);
    UPDATE agents_platform.channel_outbound SET state='suppressed',reason='member_link_revoked',updated_at=now()
      WHERE member_link_id=NEW.id AND state='pending';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER revoke_member_channel_work AFTER UPDATE OF state ON agents_platform.member_channel_links
  FOR EACH ROW EXECUTE FUNCTION agents_platform.revoke_member_channel_work();
CREATE FUNCTION agents_platform.revoke_membership_channel_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE agents_platform.member_channel_links SET state='revoked',generation=generation+1,challenge_hash=NULL,updated_at=now()
      WHERE organization_id=NEW.organization_id AND account_id=NEW.account_id AND state<>'revoked';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER revoke_membership_channel_links AFTER UPDATE OF revoked_at ON agents_platform.memberships
  FOR EACH ROW EXECUTE FUNCTION agents_platform.revoke_membership_channel_links();
CREATE FUNCTION agents_platform.revoke_connection_member_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision<>OLD.revision OR NEW.credential_revision<>OLD.credential_revision OR NEW.state<>'active' THEN
    UPDATE agents_platform.member_channel_links SET state='revoked',generation=generation+1,challenge_hash=NULL,updated_at=now()
      WHERE connection_id=NEW.id AND state<>'revoked';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER revoke_connection_member_links AFTER UPDATE OF revision,credential_revision,state ON agents_platform.channel_connections
  FOR EACH ROW EXECUTE FUNCTION agents_platform.revoke_connection_member_links();
