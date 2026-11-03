-- Runtime progress references product-owned receipts; it grants no action authority.
CREATE TABLE agents_platform.business_procedure_instances (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 origin_task_id uuid,
 definition_id text NOT NULL,
 definition_version text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','completed','cancelled')),
 route text CHECK(route ~ '^[a-z][a-z0-9_-]{0,79}$'),
 applicability jsonb NOT NULL,
 receipts jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(receipts)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,origin_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES agents_platform.conversations(organization_id,id),
 UNIQUE(organization_id,id)
);
CREATE INDEX business_procedure_scope ON agents_platform.business_procedure_instances(organization_id,agent_id,conversation_id,created_at);
CREATE TABLE agents_platform.business_procedure_commands (
 organization_id uuid NOT NULL,
 instance_id uuid NOT NULL,
 command_id uuid NOT NULL,
 request_digest text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,command_id),
 FOREIGN KEY(organization_id,instance_id) REFERENCES agents_platform.business_procedure_instances(organization_id,id)
);

CREATE UNIQUE INDEX business_procedure_active_definition ON agents_platform.business_procedure_instances(organization_id,agent_id,conversation_id,definition_id,definition_version) WHERE status IN ('active','suspended');
