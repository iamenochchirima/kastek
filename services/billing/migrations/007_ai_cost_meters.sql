-- Managed model usage debits the AI allowance at provider cost, in micro-USD.
-- Token meters stay for analytics and are no longer charged.
INSERT INTO billing.capabilities(
  key, product, name, description, kind, unit, value_type,
  display_group, display_order, visible_to_customer,
  implementation_status, credit_cost_per_unit, credit_cost_minimum, active
) VALUES
  ('agent_ai_cost', 'agents', 'AI usage', 'Managed model cost settled by agent tasks, in micro-USD.',
   'meter', 'micro_usd', 'decimal', 'Usage', 5, true, 'implemented', 1, 0, true),
  ('growth_ai_cost', 'growth', 'AI usage', 'Managed model cost settled by Growth workspace agents, in micro-USD.',
   'meter', 'micro_usd', 'decimal', 'Usage', 4, true, 'implemented', 1, 0, true)
ON CONFLICT (key) DO UPDATE SET
  unit=EXCLUDED.unit,
  value_type=EXCLUDED.value_type,
  credit_cost_per_unit=EXCLUDED.credit_cost_per_unit,
  credit_cost_minimum=EXCLUDED.credit_cost_minimum,
  implementation_status=EXCLUDED.implementation_status,
  description=EXCLUDED.description,
  active=true,
  updated_at=now();

UPDATE billing.capabilities
   SET credit_cost_per_unit=0, updated_at=now()
 WHERE key IN ('agent_tokens','growth_agent_tokens');
