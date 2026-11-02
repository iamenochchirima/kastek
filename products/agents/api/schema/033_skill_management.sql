ALTER TABLE agents_platform.skill_packages ADD COLUMN requirements jsonb NOT NULL DEFAULT '{"connectionProfiles":[],"permissions":[],"runtimes":[]}';
CREATE TABLE agents_platform.skill_installation_states (
 skill_revision_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'enabled' CHECK(state IN ('enabled','disabled','removed')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 updated_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,agent_id,skill_revision_id) REFERENCES agents_platform.skill_revisions(organization_id,agent_id,id)
);
INSERT INTO agents_platform.skill_installation_states(skill_revision_id,organization_id,agent_id,updated_by)
 SELECT id,organization_id,agent_id,created_by FROM agents_platform.skill_revisions;
CREATE TABLE agents_platform.skill_installation_mutations (
 organization_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 operation_id text NOT NULL,
 skill_revision_id uuid NOT NULL,
 request_digest text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(organization_id,agent_id,operation_id),
 FOREIGN KEY(organization_id,agent_id,skill_revision_id) REFERENCES agents_platform.skill_revisions(organization_id,agent_id,id)
);
CREATE TABLE agents_platform.skill_repository_sources (
 skill_revision_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 repository text NOT NULL CHECK(length(repository) BETWEEN 3 AND 201),
 commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
 package_path text NOT NULL CHECK(octet_length(package_path)<=256),
 tree_sha text NOT NULL CHECK(tree_sha ~ '^[a-f0-9]{40}$'),
 FOREIGN KEY(organization_id,agent_id,skill_revision_id) REFERENCES agents_platform.skill_revisions(organization_id,agent_id,id)
);
CREATE TRIGGER immutable_skill_repository_source BEFORE UPDATE OR DELETE ON agents_platform.skill_repository_sources
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
