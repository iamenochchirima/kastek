ALTER TABLE agent_memory_retrieval_decisions
  ADD COLUMN IF NOT EXISTS gate_source TEXT CHECK (gate_source IS NULL OR gate_source IN ('deterministic_prefilter', 'small_model', 'bounded_fallback')),
  ADD COLUMN IF NOT EXISTS gate_model TEXT,
  ADD COLUMN IF NOT EXISTS gate_confidence NUMERIC(5,4) CHECK (gate_confidence IS NULL OR (gate_confidence >= 0 AND gate_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS gate_latency_ms INTEGER CHECK (gate_latency_ms IS NULL OR gate_latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS gate_error_code TEXT CHECK (gate_error_code IS NULL OR gate_error_code ~ '^[A-Z][A-Z0-9_.-]{0,119}$');
