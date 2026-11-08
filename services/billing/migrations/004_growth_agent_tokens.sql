INSERT INTO billing.capabilities(
  key, product, name, description, kind, unit, value_type,
  display_group, display_order, visible_to_customer,
  implementation_status, credit_cost_per_unit, credit_cost_minimum, active
) VALUES(
  'growth_agent_tokens', 'growth', 'AI usage', 'Accounted model tokens for Growth workspace agents.',
  'meter', 'token', 'decimal', 'Usage', 5, true, 'implemented', 2, 0, true
)
ON CONFLICT (key) DO NOTHING;
