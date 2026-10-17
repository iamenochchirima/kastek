CREATE TABLE agents_platform.document_allocations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 job_id uuid NOT NULL REFERENCES agents_platform.ingestion_jobs(id),
 stage text NOT NULL CHECK(stage IN ('parse','chunk','embed')), stage_index integer NOT NULL DEFAULT 0 CHECK(stage_index BETWEEN 0 AND 63),
 profile_release text NOT NULL, input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('admitted','running','completed','failed','destroyed')),
 lease_expires_at timestamptz NOT NULL, receipt jsonb, result_key text, result_digest text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,stage,stage_index)
);
CREATE INDEX document_allocations_reap ON agents_platform.document_allocations(lease_expires_at) WHERE state<>'destroyed';
