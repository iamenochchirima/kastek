-- Destination-owned grants are separate from browser sessions and Agents membership.
CREATE TABLE product_capability_mappings (
    id TEXT PRIMARY KEY,
    origin_product TEXT NOT NULL,
    origin_tenant_id TEXT NOT NULL,
    actor_issuer TEXT NOT NULL,
    actor_subject TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tenant_user_id TEXT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE product_capability_grants (
    mapping_id TEXT NOT NULL REFERENCES product_capability_mappings(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    descriptor_digest TEXT NOT NULL,
    handler_ref TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_digest TEXT NOT NULL,
    agent_ids JSONB NOT NULL CHECK (jsonb_typeof(agent_ids) = 'array' AND jsonb_array_length(agent_ids) > 0),
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mapping_id, operation, binding_id)
);
