/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  agentPlatformPlanSidebar: [
    { type: "doc", id: "agents/agent-platform-implementation-plan", label: "Overview" },
    { type: "doc", id: "active/agent-platform-host-boundary-restructure", label: "First implementation · Runtime foundation rewrite" },
    { type: "doc", id: "active/agent-platform-hermes-aligned-runtime-reliability", label: "Second implementation · Hermes-aligned runtime" },
    {
      type: "category",
      label: "Foundations",
      items: [
        { type: "link", label: "P00 · Contracts", href: "/plans/agents/#p00-baseline-ownership-and-contract-freeze" },
        { type: "link", label: "P00B · Module boundaries", href: "/plans/agents/#p00b-module-boundaries-and-composition-root" },
        { type: "link", label: "P01 · Execution journal", href: "/plans/agents/#p01-execution-journal-and-thin-visualizer" },
        { type: "link", label: "P02 · Tenant and host adapters", href: "/plans/agents/#p02-tenant-control-plane-and-host-adapters" },
        { type: "link", label: "P03 · Durable operations", href: "/plans/agents/#p03-durable-operation-kernel" },
      ],
    },
    {
      type: "category",
      label: "Runtime and interactions",
      items: [
        { type: "link", label: "P04 · Session coordination", href: "/plans/agents/#p04-session-admission-and-ordered-coordination" },
        { type: "link", label: "P05 · Tools and providers", href: "/plans/agents/#p05-tool-capability-mcp-and-provider-runtime" },
        { type: "link", label: "P06 · Interaction and delivery", href: "/plans/agents/#p06-unified-interaction-and-delivery-lifecycle" },
        {
          type: "category",
          label: "P07 · Human assistance",
          items: [
            { type: "link", label: "Presence and availability", href: "/plans/agents/#p07a-presence-and-effective-availability" },
            { type: "link", label: "Handoff and follow-up", href: "/plans/agents/#p07b-durable-handoff-escalation-and-offline-follow-up" },
          ],
        },
      ],
    },
    {
      type: "category",
      label: "Agent capabilities",
      items: [
        { type: "link", label: "P08 · Context and knowledge", href: "/plans/agents/#p08-context-knowledge-and-memory" },
        { type: "link", label: "P09 · Agent specification", href: "/plans/agents/#p09-typed-agent-specification-and-design-graph" },
        { type: "link", label: "P09B · Graph executor", href: "/plans/agents/#p09b-durable-workflow-graph-executor" },
        { type: "link", label: "P10 · Multi-agent invocation", href: "/plans/agents/#p10-multi-agent-invocation-and-long-running-work" },
        { type: "link", label: "P11 · Capacity and safety", href: "/plans/agents/#p11-capacity-production-safety-and-execution-controls" },
        { type: "link", label: "P12 · Batch publishing", href: "/plans/agents/#p12-publishing-and-batch-execution-migration" },
      ],
    },
    {
      type: "category",
      label: "Release and rollout",
      items: [
        { type: "link", label: "P13 · Evaluation and release", href: "/plans/agents/#p13-evaluation-publication-deployment-and-release-lifecycle" },
        { type: "link", label: "P14 · Observatory and builder", href: "/plans/agents/#p14-full-agent-canvas-and-execution-observatory" },
        { type: "link", label: "P15 · Migration and rollout", href: "/plans/agents/#p15-migration-cutover-and-decommission" },
      ],
    },
  ],
};

module.exports = sidebars;
