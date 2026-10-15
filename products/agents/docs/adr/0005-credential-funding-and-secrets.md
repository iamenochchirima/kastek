# ADR 0005: Credential funding and secret boundaries

- Status: accepted
- Date: 2026-08-11
- Updated: 2026-10-03 to record the independently credentialed provider set.

## Decision

KasiTek-managed credentials are the default for KasiAi and eligible plan usage. Users may
provide independent credentials for any provider supported by the Agent Platform: OpenRouter,
OpenAI, Anthropic, Google Gemini, DeepSeek, GLM, Kimi, MiniMax, xAI, OpenCode Go, and OpenCode
Zen. Credentials are encrypted in the authoritative product secret store and are referenced by
opaque IDs from the Agent Platform. Each credential is bound to its provider; a key for one
provider cannot satisfy another provider's model, and fallback to another provider requires an
explicit effective agent policy.

Every model call records whether it was KasiTek-funded or user-funded. User-funded calls do
not silently fall back to KasiTek funding unless the effective agent policy explicitly allows
it. Raw secrets never enter prompts, workflow history, traces, logs, or sandboxes.

The production secret manager remains a deployment ADR; local development uses environment
variables only for non-production credentials.
