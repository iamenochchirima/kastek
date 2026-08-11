# ADR 0005: Credential funding and secret boundaries

- Status: accepted
- Date: 2026-08-11

## Decision

KasiTek-managed credentials are the default for KasiAi and eligible plan usage. Users may
provide OpenRouter, OpenAI, Anthropic, or Google Gemini credentials for eligible agents.
Credentials are encrypted in the authoritative product secret store and are referenced by
opaque IDs from the Agent Platform.

Every model call records whether it was KasiTek-funded or user-funded. User-funded calls do
not silently fall back to KasiTek funding unless the effective agent policy explicitly allows
it. Raw secrets never enter prompts, workflow history, traces, logs, or sandboxes.

The production secret manager remains a deployment ADR; local development uses environment
variables only for non-production credentials.
