CREATE TABLE agents_platform.api_import_catalogs (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('openapi','request_template')),
 import_digest text NOT NULL CHECK(import_digest ~ '^[a-f0-9]{64}$'),
 catalog jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 UNIQUE(organization_id,connection_id,id), UNIQUE(connection_id)
);
CREATE TRIGGER immutable_api_import BEFORE UPDATE OR DELETE ON agents_platform.api_import_catalogs
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.api_operation_templates (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 import_id uuid NOT NULL,
 alias text NOT NULL CHECK(length(alias) BETWEEN 1 AND 128),
 definition jsonb NOT NULL,
 template jsonb,
 template_digest text CHECK(template_digest ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(organization_id,connection_id,import_id) REFERENCES agents_platform.api_import_catalogs(organization_id,connection_id,id),
 UNIQUE(organization_id,connection_id,id), UNIQUE(connection_id,alias),
 CHECK((template IS NULL)=(template_digest IS NULL))
);
CREATE TRIGGER immutable_api_template BEFORE UPDATE OR DELETE ON agents_platform.api_operation_templates
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.api_connection_settings (
 connection_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 import_id uuid NOT NULL,
 catalog_id uuid REFERENCES agents_platform.capability_catalogs(id),
 status text NOT NULL CHECK(status IN ('selection_required','ready','credentials_required','unsupported','failed','disconnected')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 credential_schemes jsonb NOT NULL DEFAULT '[]',
 selected_operation_ids uuid[] NOT NULL DEFAULT '{}',
 binding_ids uuid[] NOT NULL DEFAULT '{}',
 last_error text,
 last_probe_at timestamptz,
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 FOREIGN KEY(organization_id,connection_id,import_id) REFERENCES agents_platform.api_import_catalogs(organization_id,connection_id,id)
);
CREATE TABLE agents_platform.api_operation_selections (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 effect_policy text NOT NULL CHECK(effect_policy IN ('exact_review','owner_reviewed_read')),
 created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,connection_id,operation_id) REFERENCES agents_platform.api_operation_templates(organization_id,connection_id,id),
 UNIQUE(connection_id,policy_revision,operation_id)
);
CREATE TRIGGER immutable_api_selection BEFORE UPDATE OR DELETE ON agents_platform.api_operation_selections
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
