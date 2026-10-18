ALTER TABLE agents_platform.connections
 ADD COLUMN profile_id text NOT NULL DEFAULT 'report-delivery-v1',
 ADD COLUMN policy_revision integer NOT NULL DEFAULT 1 CHECK(policy_revision > 0),
 ADD COLUMN resource_handles jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN selections jsonb NOT NULL DEFAULT '[]',
 ADD CONSTRAINT connection_profile CHECK(profile_id IN ('report-delivery-v1','github-public-read-v1','stash-read-v1')),
 ADD CONSTRAINT provider_target CHECK((profile_id='report-delivery-v1' AND target_id NOT LIKE 'provider:%') OR
  (profile_id='github-public-read-v1' AND target_id='provider:github') OR
  (profile_id='stash-read-v1' AND target_id='provider:stash')),
 ADD CONSTRAINT connection_handles_array CHECK(jsonb_typeof(resource_handles)='array' AND jsonb_typeof(selections)='array'),
 ADD CONSTRAINT stash_connection_scope CHECK(profile_id<>'stash-read-v1' OR (selections='[]'::jsonb AND jsonb_array_length(resource_handles) BETWEEN 1 AND 20));

CREATE TABLE agents_platform.capability_catalogs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL,
 account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 revision integer NOT NULL CHECK(revision > 0), credential_revision integer NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision > 0), digest text NOT NULL CHECK(length(digest)=64),
 catalog jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 FOREIGN KEY(connection_id,credential_revision) REFERENCES agents_platform.connection_credentials(connection_id,revision),
 UNIQUE(connection_id,revision), UNIQUE(organization_id,id)
);
CREATE TABLE agents_platform.capability_bindings (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL,
 catalog_id uuid NOT NULL, account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 alias text NOT NULL UNIQUE, digest text NOT NULL CHECK(length(digest)=64), binding jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 FOREIGN KEY(organization_id,catalog_id) REFERENCES agents_platform.capability_catalogs(organization_id,id),
 UNIQUE(organization_id,id)
);
CREATE TABLE agents_platform.capability_mutations (
 organization_id uuid NOT NULL, account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 operation_id text NOT NULL, request_digest text NOT NULL CHECK(length(request_digest)=64), result jsonb NOT NULL,
 PRIMARY KEY(organization_id,account_id,operation_id)
);
CREATE FUNCTION agents_platform.reject_capability_update() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Capability catalog and binding revisions are immutable'; END;
$$;
CREATE TRIGGER immutable_capability_catalog BEFORE UPDATE OR DELETE ON agents_platform.capability_catalogs
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_capability_update();
CREATE TRIGGER immutable_capability_binding BEFORE UPDATE OR DELETE ON agents_platform.capability_bindings
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_capability_update();
