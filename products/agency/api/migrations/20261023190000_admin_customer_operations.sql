CREATE TABLE admin_customer_operations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    target_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('client.suspend','client.resume')),
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed','rejected')),
    code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX admin_customer_operations_workspace_id_id ON admin_customer_operations(workspace_id,id);
