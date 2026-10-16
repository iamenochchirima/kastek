-- Declarative extension package lifecycle and immutable run snapshots.
-- Package versions may move through a lifecycle; snapshots never change after
-- they are persisted and are the only values that a run is allowed to use.

CREATE TABLE IF NOT EXISTS agent_extension_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'plugin', 'connector', 'mcp_capability')),
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-fA-F]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deprecated', 'revoked')),
  declaration JSONB NOT NULL CHECK (jsonb_typeof(declaration) = 'object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  deprecated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (organization_id, kind, package_id, version)
);

CREATE TABLE IF NOT EXISTS agent_extension_package_dependencies (
  organization_id TEXT NOT NULL,
  package_version_id UUID NOT NULL REFERENCES agent_extension_packages(id) ON DELETE CASCADE,
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('skill', 'plugin', 'connector', 'mcp_capability')),
  dependency_id TEXT NOT NULL,
  version_constraint TEXT NOT NULL DEFAULT '*',
  required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_version_id, dependency_kind, dependency_id, version_constraint),
  CHECK (char_length(trim(dependency_id)) > 0),
  CHECK (char_length(trim(version_constraint)) > 0)
);

CREATE TABLE IF NOT EXISTS agent_extension_package_compatibility (
  organization_id TEXT NOT NULL,
  package_version_id UUID PRIMARY KEY REFERENCES agent_extension_packages(id) ON DELETE CASCADE,
  min_runtime_version TEXT,
  max_runtime_version TEXT,
  supported_agent_audiences TEXT[] NOT NULL DEFAULT '{}',
  supported_channels TEXT[] NOT NULL DEFAULT '{}',
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(constraints) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_extension_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id),
  snapshot_key TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-fA-F]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, agent_version_id, checksum)
);

CREATE INDEX IF NOT EXISTS agent_extension_packages_scope_idx
  ON agent_extension_packages (organization_id, kind, status, package_id, version);
CREATE INDEX IF NOT EXISTS agent_extension_package_dependencies_scope_idx
  ON agent_extension_package_dependencies (organization_id, package_version_id);
CREATE INDEX IF NOT EXISTS agent_extension_snapshots_scope_idx
  ON agent_extension_snapshots (organization_id, agent_version_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_agent_extension_package_content_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.declaration IS DISTINCT FROM OLD.declaration
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Agent extension package content is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'revoked' OR NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'published', 'revoked'))
    OR (OLD.status = 'published' AND NEW.status IN ('published', 'deprecated', 'revoked'))
    OR (OLD.status = 'deprecated' AND NEW.status IN ('deprecated', 'revoked'))
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'Invalid agent extension package lifecycle transition'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_extension_packages_content_immutable ON agent_extension_packages;
CREATE TRIGGER agent_extension_packages_content_immutable
BEFORE UPDATE ON agent_extension_packages
FOR EACH ROW EXECUTE FUNCTION prevent_agent_extension_package_content_mutation();

CREATE OR REPLACE FUNCTION prevent_agent_extension_package_relation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Agent extension package relations are immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS agent_extension_package_dependencies_immutable ON agent_extension_package_dependencies;
CREATE TRIGGER agent_extension_package_dependencies_immutable
BEFORE UPDATE OR DELETE ON agent_extension_package_dependencies
FOR EACH ROW EXECUTE FUNCTION prevent_agent_extension_package_relation_mutation();

DROP TRIGGER IF EXISTS agent_extension_package_compatibility_immutable ON agent_extension_package_compatibility;
CREATE TRIGGER agent_extension_package_compatibility_immutable
BEFORE UPDATE OR DELETE ON agent_extension_package_compatibility
FOR EACH ROW EXECUTE FUNCTION prevent_agent_extension_package_relation_mutation();

-- A version can be pinned once. A draft may receive its first pin; replacing
-- a pin after publication would change the meaning of new runs and is rejected.
CREATE OR REPLACE FUNCTION prevent_agent_version_extension_snapshot_repin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.extension_snapshot_id IS NOT NULL
     AND NEW.extension_snapshot_id IS DISTINCT FROM OLD.extension_snapshot_id THEN
    RAISE EXCEPTION 'Agent version extension snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_version_extension_snapshot_immutable ON agent_versions;
CREATE TRIGGER agent_version_extension_snapshot_immutable
BEFORE UPDATE OF extension_snapshot_id ON agent_versions
FOR EACH ROW EXECUTE FUNCTION prevent_agent_version_extension_snapshot_repin();

CREATE OR REPLACE FUNCTION prevent_agent_extension_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Agent extension snapshots are immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS agent_extension_snapshots_immutable ON agent_extension_snapshots;
CREATE TRIGGER agent_extension_snapshots_immutable
BEFORE UPDATE OR DELETE ON agent_extension_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_agent_extension_snapshot_mutation();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_versions_extension_snapshot_fk'
  ) THEN
    ALTER TABLE agent_versions
      ADD CONSTRAINT agent_versions_extension_snapshot_fk
      FOREIGN KEY (extension_snapshot_id) REFERENCES agent_extension_snapshots(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_runs_extension_snapshot_fk'
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT agent_runs_extension_snapshot_fk
      FOREIGN KEY (extension_snapshot_id) REFERENCES agent_extension_snapshots(id)
      NOT VALID;
  END IF;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON agent_extension_packages
  TO kasitek_agents_runtime;
GRANT SELECT, INSERT
  ON agent_extension_package_dependencies, agent_extension_package_compatibility
  TO kasitek_agents_runtime;
GRANT SELECT, INSERT ON agent_extension_snapshots TO kasitek_agents_runtime;

ALTER TABLE agent_extension_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_packages FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_package_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_package_dependencies FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_package_compatibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_package_compatibility FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_extension_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_extension_packages_agents_scope ON agent_extension_packages
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id))
  WITH CHECK (kasitek_agents_operator_scope() OR kasitek_agents_current_org_scope(organization_id));

CREATE POLICY agent_extension_package_dependencies_agents_scope
  ON agent_extension_package_dependencies
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_extension_packages package
        WHERE package.id = agent_extension_package_dependencies.package_version_id
          AND package.organization_id = agent_extension_package_dependencies.organization_id
      )
    )
  );

CREATE POLICY agent_extension_package_dependencies_agents_insert
  ON agent_extension_package_dependencies
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_extension_packages package
        WHERE package.id = agent_extension_package_dependencies.package_version_id
          AND package.organization_id = agent_extension_package_dependencies.organization_id
      )
    )
  );

CREATE POLICY agent_extension_package_compatibility_agents_scope
  ON agent_extension_package_compatibility
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_extension_packages package
        WHERE package.id = agent_extension_package_compatibility.package_version_id
          AND package.organization_id = agent_extension_package_compatibility.organization_id
      )
    )
  );

CREATE POLICY agent_extension_package_compatibility_agents_insert
  ON agent_extension_package_compatibility
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_extension_packages package
        WHERE package.id = agent_extension_package_compatibility.package_version_id
          AND package.organization_id = agent_extension_package_compatibility.organization_id
      )
    )
  );

CREATE POLICY agent_extension_snapshots_agents_scope ON agent_extension_snapshots
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_extension_snapshots.agent_version_id
          AND definition.organization_id = agent_extension_snapshots.organization_id
      )
    )
  );

CREATE POLICY agent_extension_snapshots_agents_insert ON agent_extension_snapshots
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND EXISTS (
        SELECT 1 FROM agent_versions version
        JOIN agent_definitions definition ON definition.id = version.agent_definition_id
        WHERE version.id = agent_extension_snapshots.agent_version_id
          AND definition.organization_id = agent_extension_snapshots.organization_id
      )
    )
  );
