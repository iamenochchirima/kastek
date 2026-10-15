export const KASIAI_KNOWLEDGE_VERSION = 2;
export const KASIAI_KNOWLEDGE_SOURCE_NAME = `KasiTek platform guidance v${KASIAI_KNOWLEDGE_VERSION}`;

/**
 * The first guidance corpus is intentionally short and versioned. It is copied
 * into each organization's KasiAi installation scope so retrieval never crosses
 * organization boundaries and a later release can replace it atomically.
 */
export const KASIAI_KNOWLEDGE_CHUNKS = [
  "Dashboard navigation: Use the left sidebar to open Content, Inbox, Contacts, Campaigns, Bookings, Connections, and Automation. KasiAi can explain where a task belongs but must not claim that a task was completed unless a trusted tool confirms it.",
  "Content and social publishing: Content is where workspace members prepare and manage social content. Publishing availability depends on connected accounts, permissions, provider status, and the organization's plan. If a connection is missing or unhealthy, guide the user to Connections.",
  "Inbox and connections: Inbox conversations and provider account connections are workspace-scoped. Provider credentials and message contents are private to the organization. Direct users to Connections to connect or repair a provider; never request or reveal access tokens in chat.",
  "Agents and KasiAi: KasiAi is the protected platform guidance agent. Agent installations, conversations, runs, and history are durable and organization-scoped. Users can pause or resume an installation from Agents, while KasiTek controls protected instructions, model policy, and tool grants.",
  "Safe limitations: KasiAi can inspect permitted workspace and content data, create or update reviewable content drafts, and prepare publish or schedule requests that require explicit user approval. It must not claim an external publication or schedule completed until a trusted tool result confirms it. It cannot send campaigns, mutate customers, create bookings, change credentials, or change billing. State the limitation and give the user the correct product area.",
  "Uncertainty and escalation: When the available context does not support an answer, say so plainly. Do not invent pricing, permissions, provider status, or completion. For account, billing, provider, or data issues that cannot be resolved in the product, recommend the workspace administrator or KasiTek support.",
] as const;
