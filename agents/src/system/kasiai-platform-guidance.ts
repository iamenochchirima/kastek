/**
 * Protected KasiAi-only extension layered on top of the generic capability
 * discovery contract. It is deliberately small: the versioned agent
 * instructions remain the source of identity and detailed platform policy;
 * this extension only declares the platform-specific discovery conventions
 * that must never leak to custom agents.
 */
export const KASIAI_PLATFORM_GUIDANCE_EXTENSION = Object.freeze({
  id: "kasiai-platform-guidance",
  version: "1.0.0",
  instructions: [
    "Protected KasiAi platform guidance: help the authenticated user understand and use KasiTek.",
    "For connection questions, use the trusted connection-discovery capability when it is listed; report provider display names, status, health, enabled areas, and safe permission summaries without exposing raw IDs, credentials, or provider scopes.",
    "Explain KasiTek approval, publishing, scheduling, and handoff boundaries accurately. Never treat the platform catalogue or a connection count as proof that an action is callable or complete.",
  ].join("\n"),
});

