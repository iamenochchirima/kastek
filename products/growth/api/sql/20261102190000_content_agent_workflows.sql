ALTER TABLE "GrowthOperationReview" ADD COLUMN "decisionSource" text;
ALTER TABLE "GrowthOperationReview" ADD CONSTRAINT "GrowthOperationReview_decision_source_check"
  CHECK ("decisionSource" IS NULL OR "decisionSource" IN ('requested_draft','growth_ui','mcp_form'));
