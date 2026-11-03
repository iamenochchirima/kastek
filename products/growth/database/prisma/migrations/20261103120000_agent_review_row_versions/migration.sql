-- Independent review revisions do not change the meaning or precision of updatedAt.
ALTER TABLE "Conversation" ADD COLUMN "agentReviewRevision" BIGINT NOT NULL DEFAULT 1 CHECK ("agentReviewRevision" > 0);
ALTER TABLE "ExternalConnection" ADD COLUMN "agentReviewRevision" BIGINT NOT NULL DEFAULT 1 CHECK ("agentReviewRevision" > 0);
ALTER TABLE "SocialPost" ADD COLUMN "agentReviewRevision" BIGINT NOT NULL DEFAULT 1 CHECK ("agentReviewRevision" > 0);
ALTER TABLE "SocialChannelConnection" ADD COLUMN "agentReviewRevision" BIGINT NOT NULL DEFAULT 1 CHECK ("agentReviewRevision" > 0);
ALTER TABLE "WhatsappContact" ADD COLUMN "agentReviewRevision" BIGINT NOT NULL DEFAULT 1 CHECK ("agentReviewRevision" > 0);
ALTER TABLE "WhatsappContactListMembership" ADD COLUMN "agentReviewRevision" BIGINT NOT NULL DEFAULT 1 CHECK ("agentReviewRevision" > 0);

CREATE FUNCTION growth_advance_agent_review_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."agentReviewRevision" = 9223372036854775807 THEN
    RAISE EXCEPTION 'Agent review revision exhausted' USING ERRCODE = '22003';
  END IF;
  NEW."agentReviewRevision" := OLD."agentReviewRevision" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "Conversation" FOR EACH ROW EXECUTE FUNCTION growth_advance_agent_review_revision();
CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "ExternalConnection" FOR EACH ROW EXECUTE FUNCTION growth_advance_agent_review_revision();
CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "SocialPost" FOR EACH ROW EXECUTE FUNCTION growth_advance_agent_review_revision();
CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "SocialChannelConnection" FOR EACH ROW EXECUTE FUNCTION growth_advance_agent_review_revision();
CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "WhatsappContact" FOR EACH ROW EXECUTE FUNCTION growth_advance_agent_review_revision();
CREATE TRIGGER agent_review_revision BEFORE UPDATE ON "WhatsappContactListMembership" FOR EACH ROW EXECUTE FUNCTION growth_advance_agent_review_revision();
