export const COVERAGE = {
  usage: [
    {
      key: "usage_events",
      label: "Product usage events",
      status: "unavailable",
      detail: "Forwarded to the central billing service",
    },
    {
      key: "messaging",
      label: "Conversations and messages",
      status: "available",
      detail: "Core conversation and message records",
    },
    {
      key: "campaign_delivery",
      label: "Campaign delivery",
      status: "available",
      detail: "WhatsApp send-event records",
    },
    {
      key: "agent_runs",
      label: "Agent runs and model cost",
      status: "unavailable",
      detail:
        "Agent Platform reporting scope is not connected to this boundary",
    },
    {
      key: "social_insights",
      label: "Social reach and engagement",
      status: "unavailable",
      detail: "Provider insight coverage is not a Core transactional metric",
    },
  ],
  revenue: [
    {
      key: "invoices",
      label: "Invoices and collections",
      status: "unavailable",
      detail: "Owned by the central billing service",
    },
    {
      key: "subscriptions",
      label: "Subscriptions",
      status: "unavailable",
      detail: "Owned by the central billing service",
    },
    {
      key: "payments",
      label: "Paystack checkout outcomes",
      status: "unavailable",
      detail: "Owned by the central billing service",
    },
    {
      key: "refunds",
      label: "Refunds",
      status: "unavailable",
      detail: "Owned by the central billing service",
    },
    {
      key: "credits",
      label: "Credit lifecycle",
      status: "unavailable",
      detail: "Owned by the central billing service",
    },
  ],
  customers: [
    {
      key: "organization_lifecycle",
      label: "Organization lifecycle",
      status: "available",
      detail: "Organization and user creation records",
    },
    {
      key: "activation",
      label: "Activation",
      status: "partial",
      detail:
        "Activated means at least one meaningful recorded product event in the selected period",
    },
    {
      key: "customer_content",
      label: "Customer content analytics",
      status: "unavailable",
      detail:
        "Raw customer content is intentionally excluded from platform analytics",
    },
  ],
} as const;
