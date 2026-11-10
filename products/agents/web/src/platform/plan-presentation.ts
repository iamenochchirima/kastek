import type { Plan } from "./billing-settings";

export type AgentsPlanPresentation = {
  tagline: string;
  support: string;
  recommended?: boolean;
  ribbon?: string;
  agency?: boolean;
};

export const AGENTS_PLAN_PRESENTATION: Record<string, AgentsPlanPresentation> = {
  "agents-free": {
    tagline: "One agent and one channel to get started.",
    support: "Community support",
  },
  "agents-starter": {
    tagline: "Handoff, crawling and a small team.",
    support: "Email support",
  },
  "agents-growth": {
    tagline: "Assignment, analytics and unbranded widgets.",
    support: "Priority support",
    recommended: true,
    ribbon: "Most popular",
  },
  "agents-scale": {
    tagline: "More agents, channels and crawl volume.",
    support: "Priority support + onboarding",
  },
  "agents-reseller": {
    tagline: "Build and host agents for clients under your own brand.",
    support: "Dedicated support",
    agency: true,
  },
};

export function presentationFor(plan: Plan): AgentsPlanPresentation {
  return (
    AGENTS_PLAN_PRESENTATION[plan.key] ?? {
      tagline: plan.description ?? "A plan for this workspace.",
      support: "Support",
    }
  );
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function limitValue(plan: Plan, key: string): number | null {
  return numberValue(plan.entitlements.find((item) => item.key === key)?.value);
}

export function hasFeature(plan: Plan, key: string): boolean {
  return plan.entitlements.find((item) => item.key === key)?.value === true;
}

export function metric(
  plan: Plan,
  key: string,
  unit: string,
  empty = "—",
): string {
  const value = limitValue(plan, key);
  if (value === null || value === 0) return empty;
  return `${value.toLocaleString()} ${value === 1 ? unit : `${unit}s`}`;
}

export function metricNumber(plan: Plan, key: string): string {
  const value = limitValue(plan, key);
  return value === null || value === 0 ? "—" : value.toLocaleString();
}

export function formatPrice(
  amountMinor: string | number | null,
  currency: string,
): string {
  if (amountMinor === null) return "Contact sales";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(amountMinor) / 100);
}

export function formatUsd(microUsd: string | number | null | undefined): string {
  if (microUsd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(microUsd) / 1_000_000);
}

export type AgentsFeatureGroup = {
  label: string;
  included: boolean;
};

export function agentsFeatureGroups(plan: Plan): AgentsFeatureGroup[] {
  return [
    {
      label: "Customer-service agents",
      included: hasFeature(plan, "agents.feature.manage"),
    },
    { label: "Basic shared inbox", included: true },
    {
      label: "Human handoff",
      included: hasFeature(plan, "agents.feature.handoff"),
    },
    {
      label: "Inbox assignment",
      included: hasFeature(plan, "agents.feature.assignment"),
    },
    {
      label: "Inbox analytics",
      included: hasFeature(plan, "agents.feature.analytics"),
    },
    {
      label: "Website knowledge crawl",
      included: (limitValue(plan, "limit.crawl_pages") ?? 0) > 0,
    },
    {
      label: "Remove KasiTek badge",
      included: hasFeature(plan, "agents.feature.branding"),
    },
    { label: "Knowledge uploads and training", included: true },
  ];
}

export type ComparisonCell =
  | { kind: "included" }
  | { kind: "excluded" }
  | { kind: "value"; value: string };

export type ComparisonRow = {
  label: string;
  cell: (plan: Plan) => ComparisonCell;
};

export type ComparisonGroup = {
  label: string;
  rows: ComparisonRow[];
};

const included = (value: boolean): ComparisonCell =>
  value ? { kind: "included" } : { kind: "excluded" };

const valueText = (value: string): ComparisonCell => ({
  kind: "value",
  value,
});

export const AGENTS_COMPARISON: ComparisonGroup[] = [
  {
    label: "Workspace",
    rows: [
      {
        label: "Team seats",
        cell: (plan) => valueText(metric(plan, "limit.agent_seats", "seat")),
      },
    ],
  },
  {
    label: "Agents",
    rows: [
      {
        label: "Agents",
        cell: (plan) => valueText(metric(plan, "limit.agent_count", "agent")),
      },
      {
        label: "Channels",
        cell: (plan) => valueText(metric(plan, "limit.agent_channels", "channel")),
      },
      {
        label: "AI usage",
        cell: (plan) =>
          valueText(
            plan.creditsPerPeriod && Number(plan.creditsPerPeriod) > 0
              ? formatUsd(plan.creditsPerPeriod)
              : "—",
          ),
      },
      {
        label: "Managed models",
        cell: (plan) => valueText(plan.key === "agents-free" ? "Free models" : "Included"),
      },
    ],
  },
  {
    label: "Knowledge",
    rows: [
      { label: "Knowledge uploads and training", cell: () => included(true) },
      {
        label: "Website crawl pages per month",
        cell: (plan) => valueText(metric(plan, "limit.crawl_pages", "page")),
      },
    ],
  },
  {
    label: "Inbox",
    rows: [
      { label: "Basic shared inbox", cell: () => included(true) },
      {
        label: "Human handoff",
        cell: (plan) => included(hasFeature(plan, "agents.feature.handoff")),
      },
      {
        label: "Inbox assignment",
        cell: (plan) => included(hasFeature(plan, "agents.feature.assignment")),
      },
      {
        label: "Inbox analytics",
        cell: (plan) => included(hasFeature(plan, "agents.feature.analytics")),
      },
    ],
  },
  {
    label: "Branding",
    rows: [
      {
        label: "Remove KasiTek badge",
        cell: (plan) => included(hasFeature(plan, "agents.feature.branding")),
      },
      {
        label: "Custom domain",
        cell: () => valueText("Agency"),
      },
      {
        label: "Client workspaces and resale",
        cell: () => valueText("Agency"),
      },
    ],
  },
  {
    label: "Support",
    rows: [
      {
        label: "Support",
        cell: (plan) => valueText(presentationFor(plan).support),
      },
    ],
  },
];
