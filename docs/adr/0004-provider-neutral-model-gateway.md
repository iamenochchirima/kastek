# ADR 0004: Provider-neutral model gateway

- Status: accepted
- Date: 2026-08-11

## Decision

Agent definitions and run records use KasiTek-owned provider-neutral message, tool, usage,
error, and capability contracts. OpenRouter is the initial default adapter. Direct OpenAI,
Anthropic, and Google Gemini adapters are part of the initial delivery. Provider response
types never become application state.

Model identifiers are pinned through versioned policy. Every call records the actual provider,
model, usage, latency, finish reason, and funding source. Unsupported capabilities fail
validation instead of silently degrading.

## Consequences

Providers can be changed for cost, availability, capability, or privacy policy without
migrating agent history. The gateway must own retries, timeout classification, circuit
breaking, and budget checks.
