CREATE TABLE agents_platform.resource_executor_hosts (
  executor_id text PRIMARY KEY CHECK(length(executor_id) BETWEEN 1 AND 80),
  physical_identity_digest text NOT NULL CHECK(physical_identity_digest ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agents_platform.resource_executor_owners (
  resource_kind text NOT NULL CHECK(resource_kind IN ('sandbox','document')),
  allocation_id uuid NOT NULL,
  executor_id text NOT NULL CHECK(length(executor_id) BETWEEN 1 AND 80),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz,
  quiescent boolean NOT NULL DEFAULT false,
  quiescence_receipt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(resource_kind,allocation_id),
  CHECK(NOT quiescent OR quiescence_receipt IS NOT NULL)
);
CREATE INDEX resource_executor_leases ON agents_platform.resource_executor_owners(executor_id,lease_expires_at) WHERE NOT quiescent;
ALTER TABLE agents_platform.sandbox_allocations ADD COLUMN launch_claimed_at timestamptz;
ALTER TABLE agents_platform.document_allocations ADD COLUMN launch_claimed_at timestamptz, ADD COLUMN cleanup_requested_at timestamptz;
ALTER TABLE agents_platform.query_embedding_allocations ADD COLUMN launch_claimed_at timestamptz, ADD COLUMN cleanup_requested_at timestamptz;
