import type { AvailablePlan, PlanEntitlement } from "@/lib/billing";

export type GrowthPlanPresentation = {
  tagline: string;
  support: string;
  recommended?: boolean;
  ribbon?: string;
};

export const GROWTH_PLAN_PRESENTATION: Record<string, GrowthPlanPresentation> = {
  "growth-free": {
    tagline: "Run your customer inbox with one seat.",
    support: "Community support",
  },
  "growth-entry": {
    tagline: "Campaigns, content and agents for a small team.",
    support: "Email support",
  },
  "growth-mid": {
    tagline: "More volume, analytics and priority support.",
    support: "Priority support",
    recommended: true,
    ribbon: "Most popular",
  },
  "growth-scale": {
    tagline: "High volume and onboarding for a larger operation.",
    support: "Priority support + onboarding",
  },
};

export function presentationFor(plan: AvailablePlan): GrowthPlanPresentation {
  return (
    GROWTH_PLAN_PRESENTATION[plan.key] ?? {
      tagline: plan.description ?? "A plan for this workspace.",
      support: "Support",
    }
  );
}

export function entitlementFor(
  plan: AvailablePlan,
  key: string,
): PlanEntitlement | undefined {
  return plan.entitlements.find((item) => item.key === key);
}

export function hasFeature(plan: AvailablePlan, key: string): boolean {
  return entitlementFor(plan, key)?.value === true;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function limitValue(plan: AvailablePlan, key: string): number | null {
  return numberValue(entitlementFor(plan, key)?.value);
}

export function planMetric(
  plan: AvailablePlan,
  key: string,
  unit: string,
  empty = "—",
): string {
  const value = limitValue(plan, key);
  if (value === null || value === 0) return empty;
  return `${value.toLocaleString()} ${unit}`;
}

export function formatPrice(
  amountMinor: number | null,
  currency: string,
): string {
  if (amountMinor === null) return "Contact sales";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

export function formatUsd(microUsd: number | null): string {
  if (microUsd === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microUsd / 1_000_000);
}

export function formatStatus(status: string | null): string {
  if (!status) return "No active plan";
  return status
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

export type GrowthFeatureGroup = {
  label: string;
  included: boolean;
};

export function growthFeatureGroups(plan: AvailablePlan): GrowthFeatureGroup[] {
  return [
    {
      label: "Inbox, contacts, calls and bookings",
      included:
        hasFeature(plan, "feature.inbox.access") &&
        hasFeature(plan, "feature.contacts.access") &&
        hasFeature(plan, "feature.bookings.access"),
    },
    {
      label: "Message templates",
      included: hasFeature(plan, "feature.templates.manage"),
    },
    {
      label: "Campaigns",
      included:
        hasFeature(plan, "feature.campaigns.manage") &&
        hasFeature(plan, "feature.campaigns.send"),
    },
    {
      label: "Content and social",
      included:
        hasFeature(plan, "feature.content.manage") &&
        hasFeature(plan, "feature.content.publish"),
    },
    {
      label: "Workspace agents",
      included: hasFeature(plan, "feature.agents.manage"),
    },
    {
      label: "Analytics",
      included: hasFeature(plan, "feature.analytics.view"),
    },
    {
      label: "API and MCP",
      included: (limitValue(plan, "limit.public_api_requests") ?? 0) > 0,
    },
  ];
}

export type ComparisonCell =
  | { kind: "included" }
  | { kind: "excluded" }
  | { kind: "value"; value: string };

export type ComparisonRow = {
  label: string;
  cell: (plan: AvailablePlan) => ComparisonCell;
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

export const GROWTH_COMPARISON: ComparisonGroup[] = [
  {
    label: "Workspace",
    rows: [
      {
        label: "Team seats",
        cell: (plan) =>
          valueText(planMetric(plan, "limit.team_seats", "seats")),
      },
      {
        label: "Connected channels",
        cell: (plan) =>
          valueText(planMetric(plan, "limit.connected_channels", "channels")),
      },
    ],
  },
  {
    label: "Customer conversations",
    rows: [
      {
        label: "Shared inbox",
        cell: (plan) => included(hasFeature(plan, "feature.inbox.access")),
      },
      {
        label: "Contacts",
        cell: (plan) => included(hasFeature(plan, "feature.contacts.access")),
      },
      { label: "Calls", cell: () => included(true) },
      {
        label: "Bookings",
        cell: (plan) => included(hasFeature(plan, "feature.bookings.access")),
      },
      {
        label: "Message templates",
        cell: (plan) =>
          included(hasFeature(plan, "feature.templates.manage")),
      },
    ],
  },
  {
    label: "Campaigns",
    rows: [
      {
        label: "Campaigns",
        cell: (plan) =>
          included(
            hasFeature(plan, "feature.campaigns.manage") &&
              hasFeature(plan, "feature.campaigns.send"),
          ),
      },
      {
        label: "Recipients per month",
        cell: (plan) =>
          valueText(planMetric(plan, "limit.campaign_recipients", "recipients")),
      },
    ],
  },
  {
    label: "Content",
    rows: [
      {
        label: "Content and social",
        cell: (plan) =>
          included(
            hasFeature(plan, "feature.content.manage") &&
              hasFeature(plan, "feature.content.publish"),
          ),
      },
      {
        label: "Posts per month",
        cell: (plan) =>
          valueText(planMetric(plan, "limit.social_publishes", "posts")),
      },
    ],
  },
  {
    label: "Agents and AI",
    rows: [
      {
        label: "Workspace agents",
        cell: (plan) => included(hasFeature(plan, "feature.agents.manage")),
      },
      {
        label: "AI usage",
        cell: (plan) =>
          valueText(
            plan.creditsPerPeriod && plan.creditsPerPeriod > 0
              ? formatUsd(plan.creditsPerPeriod)
              : "—",
          ),
      },
    ],
  },
  {
    label: "Analytics and API",
    rows: [
      {
        label: "Analytics",
        cell: (plan) => included(hasFeature(plan, "feature.analytics.view")),
      },
      {
        label: "API requests per month",
        cell: (plan) =>
          valueText(planMetric(plan, "limit.public_api_requests", "requests")),
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
