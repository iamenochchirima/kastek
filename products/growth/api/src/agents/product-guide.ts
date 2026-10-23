import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { requireCapability } from "../services/billing.js";
import type { GrowthAgentScope } from "./scope.js";

const pages = [
  { title: "Agents", route: "/agents", capability: null, purpose: "Private agent conversations, task status and review.", agentActions: ["Read authorized business and attached record context", "Continue or cancel your tasks"] },
  { title: "Workspace", route: "/workspace/settings", capability: null, purpose: "Business settings. Page permissions govern changes.", agentActions: ["Explain the current business details"] },
  { title: "Content", route: "/content/posts", capability: "feature.content.manage", purpose: "Review and edit content drafts and their connected accounts.", agentActions: ["Suggest content", "Prepare an editable draft review", "Save the exact approved draft to a selected connected account"] },
  { title: "Campaigns", route: "/campaigns", capability: "feature.campaigns.manage", purpose: "Manage WhatsApp campaigns and inspect their delivery.", agentActions: ["Read an explicitly attached WhatsApp campaign", "Explain observed status and recommend changes"] },
  { title: "Analytics", route: "/analytics", capability: "feature.analytics.view", purpose: "Read business reports for an explicit range.", agentActions: ["Read an attached report through the configured analytics gateway"] },
  { title: "Inbox", route: "/inbox", capability: "feature.inbox.access", purpose: "Staff manage connected customer conversations.", agentActions: [] },
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
    revision: "growth-product-guide-v1", pages: visible,
    unavailableAgentActions: ["External web research", "Automatic publishing or scheduling", "Campaign launch or recipient changes",
      "Autonomous replies to Growth Inbox conversations", "Personal memory, subagents or sandbox execution in Growth features"],
    customerChannelSetup: "Customer-facing website and messaging agents use the separate Agents platform deployment and Inbox.",
  };
}
