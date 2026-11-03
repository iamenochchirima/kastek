ALTER TABLE agents_platform.skill_revisions ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE agents_platform.skill_revisions ADD COLUMN created_by_service jsonb;
ALTER TABLE agents_platform.skill_revisions ADD CONSTRAINT skill_revision_creator CHECK ((created_by IS NOT NULL)::int + (created_by_service IS NOT NULL)::int=1);
ALTER TABLE agents_platform.skill_package_reviews ALTER COLUMN reviewed_by DROP NOT NULL;
ALTER TABLE agents_platform.skill_package_reviews ADD COLUMN reviewed_by_service jsonb;
ALTER TABLE agents_platform.skill_package_reviews ADD CONSTRAINT skill_package_reviewer CHECK ((reviewed_by IS NOT NULL)::int + (reviewed_by_service IS NOT NULL)::int=1);
ALTER TABLE agents_platform.skill_installation_states ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE agents_platform.skill_installation_states ADD COLUMN updated_by_service jsonb;
ALTER TABLE agents_platform.skill_installation_states ADD CONSTRAINT skill_installation_actor CHECK ((updated_by IS NOT NULL)::int + (updated_by_service IS NOT NULL)::int=1);
ALTER TABLE agents_platform.sources ALTER COLUMN importer_account_id DROP NOT NULL;
ALTER TABLE agents_platform.sources ADD COLUMN importer_service jsonb;
ALTER TABLE agents_platform.sources ADD CONSTRAINT source_importer CHECK ((importer_account_id IS NOT NULL)::int + (importer_service IS NOT NULL)::int=1);
ALTER TABLE agents_platform.ingestion_jobs ALTER COLUMN importer_account_id DROP NOT NULL;
ALTER TABLE agents_platform.ingestion_jobs ADD COLUMN importer_service jsonb;
ALTER TABLE agents_platform.ingestion_jobs ADD CONSTRAINT ingestion_importer CHECK ((importer_account_id IS NOT NULL)::int + (importer_service IS NOT NULL)::int=1);
CREATE UNIQUE INDEX product_ingestion_request ON agents_platform.ingestion_jobs(organization_id,importer_service,operation_id) WHERE importer_service IS NOT NULL;
ALTER TABLE agents_platform.source_revision_policy ADD COLUMN approved_by_service jsonb;
ALTER TABLE agents_platform.source_revision_policy DROP CONSTRAINT source_revision_policy_check;
ALTER TABLE agents_platform.source_revision_policy ADD CONSTRAINT source_reviewer CHECK (
  (approved_at IS NULL AND approved_by IS NULL AND approved_by_service IS NULL) OR
  (approved_at IS NOT NULL AND (approved_by IS NOT NULL)::int + (approved_by_service IS NOT NULL)::int=1));
ALTER TABLE agents_platform.source_mutations DROP CONSTRAINT source_mutations_pkey;
ALTER TABLE agents_platform.source_mutations ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE agents_platform.source_mutations ADD COLUMN actor_service jsonb;
ALTER TABLE agents_platform.source_mutations ADD CONSTRAINT source_mutation_actor CHECK ((account_id IS NOT NULL)::int + (actor_service IS NOT NULL)::int=1);
CREATE UNIQUE INDEX source_mutation_identity ON agents_platform.source_mutations(organization_id,account_id,actor_service,operation_id) NULLS NOT DISTINCT;

CREATE FUNCTION agents_platform.knowledge_import_authorized(job agents_platform.ingestion_jobs) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN job.importer_service IS NULL THEN EXISTS (
    SELECT 1 FROM agents_platform.memberships m WHERE m.organization_id=job.organization_id AND m.account_id=job.importer_account_id AND m.revoked_at IS NULL
  ) ELSE EXISTS (
    SELECT 1 FROM agents_platform.product_execution_tenants n JOIN agents_platform.product_execution_features f
      ON f.product=n.product AND f.tenant_id=n.tenant_id AND f.organization_id=n.organization_id
    WHERE n.organization_id=job.organization_id AND n.product=job.importer_service->>'product' AND n.tenant_id=job.importer_service->>'tenantId'
      AND n.client_id=job.importer_service->'service'->>'clientId' AND n.issuer=job.importer_service->'service'->>'issuer'
      AND n.revoked_at IS NULL AND f.agent_id::text=job.importer_service->>'agentId' AND f.enabled
  ) END
$$;
