import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { requireCapability } from "../services/billing.js";
import type { GrowthAgentScope } from "./scope.js";

const pages = [
  { title: "Agents", route: "/agents", capability: null, purpose: "Private agent conversations, task status and review.", agentActions: ["Read authorized business context and discover permitted records", "Coordinate permitted specialists", "Update, continue or cancel your tasks"] },
  { title: "Workspace", route: "/workspace/settings", capability: null, purpose: "Business settings. Page permissions govern changes.", agentActions: ["Explain the current business details"] },
  { title: "Content", route: "/content/posts", capability: "feature.content.manage", purpose: "Draft, review and publish content using permitted accounts.", agentActions: ["Suggest or revise content without a connected social account", "Prepare an exact reviewed draft and save approved content", "Use selected tools for authorized publishing or scheduling"] },
  { title: "Campaigns", route: "/campaigns", capability: "feature.campaigns.manage", purpose: "Manage WhatsApp campaigns and inspect their delivery.", agentActions: ["Find and read permitted WhatsApp campaigns", "Explain observed status and recommend changes"] },
  { title: "Analytics", route: "/analytics", capability: "feature.analytics.view", purpose: "Read business reports for an explicit range.", agentActions: ["Read reports for an explicit authorized range through the configured analytics gateway"] },
  { title: "Inbox", route: "/inbox", capability: "feature.inbox.access", purpose: "Staff manage connected customer conversations.", agentActions: ["Read permitted conversations and prepare exact reviewed replies when the required tools are selected"] },
] as const;
export async function growthAgentProductGuide(core: CoreContext, scope: GrowthAgentScope) {
  const visible = [];
  for (const page of pages) {
    if (page.capability) {
      try { await requireCapability(core.pool, scope.tenantId, page.capability); }
      catch (error) { if (error instanceof ApiError && error.status === 403) continue; throw error; }
    }
    visible.push({ title: page.title, route: page.route, purpose: page.purpose, agentActions: page.agentActions });
  }
  return {
    revision: "growth-product-guide-v4", pages: visible,
    executionPolicy: "Selected tools and current permissions determine available actions. This guide grants no authority. Writes require their exact review; a proposal or queued action is not a completed effect.",
    contentRules: "Content drafts can be saved before connecting a social account. A connected authorized destination is required for publishing, not for writing or revising draft text.",
    memoryPolicy: "Personal memory is optional and scoped to the actor and agent. The user must enable it and review each proposed memory before acceptance; acknowledgement alone does not store memory.",
    unavailableAgentActions: ["External web research", "Unreviewed publishing or scheduling", "Campaign launch or recipient changes",
      "Autonomous replies to Growth Inbox conversations", "Sandbox execution in Growth features"],
    customerChannelSetup: "Customer-facing website and messaging agents use the separate Agents platform deployment and Inbox.",
  };
}
