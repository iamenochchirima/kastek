UPDATE billing.capabilities
   SET implementation_status='implemented', updated_at=now()
 WHERE key IN ('limit.agent_count','limit.agent_channels');
