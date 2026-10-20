CREATE TABLE agents_platform.booking_policies (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 agent_id uuid NOT NULL,
 owner_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 definition jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','withdrawn')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
 UNIQUE(organization_id,id)
);
CREATE TABLE agents_platform.booking_intents (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 operation_id text NOT NULL,
 policy_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 principal jsonb NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','approved','rejected','claimed','confirmed','conflict','uncertain','expired')),
 expires_at timestamptz NOT NULL,
 approved_at timestamptz,
 claimed_at timestamptz,
 result jsonb,
 provider_result jsonb,
 reconcile_lease uuid,
 reconcile_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,policy_id) REFERENCES agents_platform.booking_policies(organization_id,id),
 UNIQUE(task_id,operation_id), CHECK(ends_at>starts_at)
);
CREATE TABLE agents_platform.booking_slots (
 booking_id uuid PRIMARY KEY REFERENCES agents_platform.booking_intents(id),
 connection_id uuid NOT NULL,
 calendar_id text NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('held','confirmed','uncertain','released')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at)
);
CREATE INDEX booking_slot_calendar ON agents_platform.booking_slots(calendar_id,starts_at,ends_at) WHERE state<>'released';
CREATE TABLE agents_platform.booking_attempts (
 booking_id uuid NOT NULL REFERENCES agents_platform.booking_intents(id),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 16),
 phase text NOT NULL CHECK(phase IN ('availability','create','reconcile')),
 state text NOT NULL CHECK(state IN ('started','completed')),
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(booking_id,ordinal)
);
CREATE INDEX booking_intents_task ON agents_platform.booking_intents(task_id,created_at);
