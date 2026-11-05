ALTER TABLE "GrowthOperationReview" DROP CONSTRAINT "GrowthOperationReview_decision_source_check";
ALTER TABLE "GrowthOperationReview" ADD CONSTRAINT "GrowthOperationReview_decision_source_check"
  CHECK ("decisionSource" IS NULL OR "decisionSource" IN ('requested_draft','requested_action','growth_ui','mcp_form','mcp_app'));
