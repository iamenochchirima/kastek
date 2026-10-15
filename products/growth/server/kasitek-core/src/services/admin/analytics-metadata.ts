export const COVERAGE = {
  usage: [
    {
      key: "usage_events",
      label: "Product usage events",
      status: "available",
      detail: "Transactional Core usage records",
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
      status: "available",
      detail: "Core invoice records with provider references",
    },
    {
      key: "subscriptions",
      label: "Subscriptions",
      status: "available",
      detail: "Core subscription state and plan catalog",
    },
    {
      key: "payments",
      label: "Paystack checkout outcomes",
      status: "available",
      detail: "Core checkout and webhook reconciliation records",
    },
    {
      key: "refunds",
      label: "Refunds",
      status: "partial",
      detail:
        "Refunded invoice statuses; provider-level net settlement is not stored",
    },
    {
      key: "credits",
      label: "Credit lifecycle",
      status: "available",
      detail: "Core credit ledger records",
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
