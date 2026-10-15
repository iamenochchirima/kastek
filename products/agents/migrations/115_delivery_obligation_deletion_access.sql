-- Agent aggregate deletion removes its own delivery obligations after the
-- same organization/run/conversation scope checks used by the coordinator.
GRANT DELETE ON agent_delivery_obligations TO kasitek_agents_runtime;
