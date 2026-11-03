-- Existing resource handles remain valid. The two new namespaces hold private read
-- receipt and deduplicated access-scope references, not business content.
ALTER TABLE "GrowthAgentSourceHandle"
  ADD CONSTRAINT "GrowthAgentSourceHandle_id_v2_check"
  CHECK (id ~ '^growth-(resource|read-access|read-scope):[a-f0-9]{64}$') NOT VALID;
ALTER TABLE "GrowthAgentSourceHandle" VALIDATE CONSTRAINT "GrowthAgentSourceHandle_id_v2_check";
ALTER TABLE "GrowthAgentSourceHandle" DROP CONSTRAINT "GrowthAgentSourceHandle_id_check";
