CREATE INDEX customer_conversations_agent_updated ON agents_platform.customer_conversations
  (organization_id, agent_id, updated_at DESC, id DESC);
CREATE INDEX website_deployments_active_agent ON agents_platform.website_deployments
  (organization_id, agent_id) WHERE revoked_at IS NULL;
