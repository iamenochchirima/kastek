export const REPORT_DEFINITIONS = [
  {key:"cross-product",name:"Cross-product reporting",description:"Scoped Growth, Agents and Agency metrics.",source:"Product-owned APIs and Labs Analytics",version:1},
  {
    key: "platform-overview",
    name: "Platform overview",
    description:
      "Daily organizations, users, operations, and collected revenue.",
    source: "Core authoritative records",
    version: 1,
  },
  {
    key: "usage-daily",
    name: "Usage by day",
    description:
      "Daily operations, conversations, messages, sends, and credits consumed.",
    source: "Core authoritative records",
    version: 1,
  },
  {
    key: "revenue-daily",
    name: "Revenue by day",
    description:
      "Daily collections, refunds, paid invoices, and failed checkouts.",
    source: "Core billing records",
    version: 1,
  },
  {
    key: "customer-cohorts",
    name: "Customer cohorts",
    description: "Organization activity and current plan distribution.",
    source: "Core organization and billing records",
    version: 1,
  },
] as const;
