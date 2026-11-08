import "dotenv/config";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createPool, transaction } from "./db.js";

type ProductKey = "growth" | "agents" | "agency";

const CAPABILITIES: Array<{
  key: string;
  product: ProductKey;
  name: string;
  description: string;
  kind: "feature" | "limit" | "meter";
  unit?: string;
  valueType: "boolean" | "integer" | "decimal" | "string";
  displayGroup: string;
  displayOrder: number;
  implementationStatus: "implemented" | "product_pending" | "display_only";
  creditCostPerUnit?: string | null;
  creditCostMinimum?: string;
}> = [
  // Growth features
  { key: "feature.inbox.access", product: "growth", name: "Shared inbox", description: "Access connected customer conversations in one inbox.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 10, implementationStatus: "implemented" },
  { key: "feature.contacts.access", product: "growth", name: "Contacts", description: "Access and manage workspace customer records.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 20, implementationStatus: "implemented" },
  { key: "feature.bookings.access", product: "growth", name: "Bookings", description: "Manage workspace booking services and appointments.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 30, implementationStatus: "implemented" },
  { key: "feature.campaigns.manage", product: "growth", name: "Campaigns", description: "Create and manage customer messaging campaigns.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 40, implementationStatus: "implemented" },
  { key: "feature.campaigns.send", product: "growth", name: "Campaign sending", description: "Launch campaigns and send messages to campaign recipients.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 50, implementationStatus: "implemented" },
  { key: "feature.templates.manage", product: "growth", name: "Message templates", description: "Create and manage reusable provider message templates.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 60, implementationStatus: "implemented" },
  { key: "feature.content.manage", product: "growth", name: "Content workspace", description: "Plan, create, schedule, and manage multi-platform content.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 70, implementationStatus: "implemented" },
  { key: "feature.content.publish", product: "growth", name: "Content publishing", description: "Publish approved content to connected social accounts.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 80, implementationStatus: "implemented" },
  { key: "feature.analytics.view", product: "growth", name: "Analytics", description: "View workspace, campaign, and connected-channel analytics.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 90, implementationStatus: "implemented" },
  { key: "feature.agents.manage", product: "growth", name: "Workspace agents", description: "Create, configure, and deploy workspace agents.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 100, implementationStatus: "implemented" },
  // Growth limits
  { key: "limit.team_seats", product: "growth", name: "Team seats", description: "Active members and pending invitations.", kind: "limit", unit: "seats", valueType: "integer", displayGroup: "Limits", displayOrder: 10, implementationStatus: "implemented" },
  { key: "limit.connected_channels", product: "growth", name: "Connected channels", description: "Active external connections.", kind: "limit", unit: "channels", valueType: "integer", displayGroup: "Limits", displayOrder: 20, implementationStatus: "implemented" },
  { key: "limit.campaign_recipients", product: "growth", name: "Campaign recipients", description: "Campaign recipients per month.", kind: "limit", unit: "recipients", valueType: "integer", displayGroup: "Limits", displayOrder: 30, implementationStatus: "implemented" },
  { key: "limit.social_publishes", product: "growth", name: "Published content", description: "Social publishing operations per month.", kind: "limit", unit: "posts", valueType: "integer", displayGroup: "Limits", displayOrder: 40, implementationStatus: "implemented" },
  { key: "limit.agent_deployments", product: "growth", name: "Agent deployments", description: "Agent deployment operations per month.", kind: "limit", unit: "deployments", valueType: "integer", displayGroup: "Limits", displayOrder: 50, implementationStatus: "implemented" },
  { key: "limit.public_api_requests", product: "growth", name: "Public API requests", description: "Authenticated public API requests per month.", kind: "limit", unit: "requests", valueType: "integer", displayGroup: "Limits", displayOrder: 60, implementationStatus: "implemented" },
  // Growth meters
  { key: "campaign_recipients", product: "growth", name: "Campaign recipient usage", description: "Campaign recipient meter.", kind: "meter", unit: "recipient", valueType: "integer", displayGroup: "Usage", displayOrder: 10, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  { key: "social_publishes", product: "growth", name: "Social publish usage", description: "Social publishing meter.", kind: "meter", unit: "post", valueType: "integer", displayGroup: "Usage", displayOrder: 20, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  { key: "agent_deployments", product: "growth", name: "Agent deployment usage", description: "Agent deployment meter.", kind: "meter", unit: "deployment", valueType: "integer", displayGroup: "Usage", displayOrder: 30, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  { key: "public_api_requests", product: "growth", name: "Public API usage", description: "Public API request meter.", kind: "meter", unit: "request", valueType: "integer", displayGroup: "Usage", displayOrder: 40, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  // Agents
  { key: "agents.feature.manage", product: "agents", name: "Agents workspace", description: "Create and run standalone customer-service agents.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 10, implementationStatus: "implemented" },
  { key: "agent_tokens", product: "agents", name: "Agent tokens", description: "Accounted model tokens settled by agent tasks.", kind: "meter", unit: "token", valueType: "decimal", displayGroup: "Usage", displayOrder: 10, implementationStatus: "implemented", creditCostPerUnit: "2", creditCostMinimum: "0" },
  { key: "limit.agent_tokens", product: "agents", name: "Monthly agent tokens", description: "Accounted tokens per month.", kind: "limit", unit: "tokens", valueType: "integer", displayGroup: "Limits", displayOrder: 10, implementationStatus: "implemented" },
  { key: "limit.agent_count", product: "agents", name: "Agents", description: "Active agent definitions.", kind: "limit", unit: "agents", valueType: "integer", displayGroup: "Limits", displayOrder: 20, implementationStatus: "product_pending" },
  { key: "limit.agent_channels", product: "agents", name: "Agent channels", description: "Connected agent channels.", kind: "limit", unit: "channels", valueType: "integer", displayGroup: "Limits", displayOrder: 30, implementationStatus: "product_pending" },
  // Agency
  { key: "agency.feature.agents", product: "agency", name: "Agency agents", description: "Configure and run agents for Agency client workspaces.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 10, implementationStatus: "implemented" },
  { key: "agency_agent_commands", product: "agency", name: "Agency agent commands", description: "Accepted agent commands for client workspaces.", kind: "meter", unit: "command", valueType: "integer", displayGroup: "Usage", displayOrder: 10, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  { key: "limit.agency_workspaces", product: "agency", name: "Client workspaces", description: "Active client workspaces.", kind: "limit", unit: "workspaces", valueType: "integer", displayGroup: "Limits", displayOrder: 10, implementationStatus: "product_pending" },
  { key: "limit.agency_staff", product: "agency", name: "Partner staff seats", description: "Partner staff seats.", kind: "limit", unit: "seats", valueType: "integer", displayGroup: "Limits", displayOrder: 20, implementationStatus: "product_pending" },
  { key: "limit.agency_agent_commands", product: "agency", name: "Monthly agent commands", description: "Accepted agent commands per month.", kind: "limit", unit: "commands", valueType: "integer", displayGroup: "Limits", displayOrder: 30, implementationStatus: "implemented" },
];

const DISPLAY_ONLY_LIMITS = new Set([
  "limit.social_publishes",
  "limit.agent_deployments",
  "limit.public_api_requests",
  "limit.agent_count",
  "limit.agent_channels",
  "limit.agency_workspaces",
  "limit.agency_staff",
]);

interface SeedPlan {
  product: ProductKey;
  key: string;
  name: string;
  description: string;
  amountMinor: number;
  active: boolean;
  credits: number | null;
  entitlements: Array<{
    key: string;
    value: unknown;
    enforcement?: "hard" | "soft" | "display_only";
    visible?: boolean;
  }>;
}

const PLANS: SeedPlan[] = [
  {
    product: "growth",
    key: "growth-free",
    name: "Free",
    description: "Inbox, contacts and bookings for one small workspace.",
    amountMinor: 0,
    active: true,
    credits: 0,
    entitlements: [
      ["feature.inbox.access", true],
      ["feature.contacts.access", true],
      ["feature.bookings.access", true],
      ["limit.team_seats", 1],
      ["limit.connected_channels", 1],
      ["limit.campaign_recipients", 0],
      ["limit.social_publishes", 0],
      ["limit.agent_deployments", 0],
      ["limit.public_api_requests", 1_000],
    ].map(([key, value]) => ({ key: String(key), value })),
  },
  {
    product: "growth",
    key: "growth-entry",
    name: "Growth",
    description: "Inbox, contacts, bookings and limited campaigns for a small team.",
    amountMinor: 35_000,
    active: false,
    credits: 5_000_000,
    entitlements: [
      ["feature.inbox.access", true],
      ["feature.contacts.access", true],
      ["feature.bookings.access", true],
      ["feature.campaigns.manage", true],
      ["feature.campaigns.send", true],
      ["feature.templates.manage", true],
      ["limit.team_seats", 3],
      ["limit.connected_channels", 1],
      ["limit.campaign_recipients", 500],
      ["limit.social_publishes", 0],
      ["limit.agent_deployments", 0],
      ["limit.public_api_requests", 5_000],
    ].map(([key, value]) => ({ key: String(key), value })),
  },
  {
    product: "growth",
    key: "growth-mid",
    name: "Growth Mid",
    description: "Campaigns, social, analytics and workspace agents for a growing team.",
    amountMinor: 99_900,
    active: false,
    credits: 20_000_000,
    entitlements: [
      ...["inbox", "contacts", "bookings", "campaigns", "templates", "content", "analytics", "agents"].map((name) => ({
        key: `feature.${name === "campaigns" ? "campaigns.manage" : name === "templates" ? "templates.manage" : name === "content" ? "content.manage" : name === "analytics" ? "analytics.view" : name === "agents" ? "agents.manage" : `${name}.access`}`,
        value: true,
      })),
      { key: "feature.campaigns.send", value: true },
      { key: "feature.content.publish", value: true },
      { key: "limit.team_seats", value: 10 },
      { key: "limit.connected_channels", value: 5 },
      { key: "limit.campaign_recipients", value: 5_000 },
      { key: "limit.social_publishes", value: 150 },
      { key: "limit.agent_deployments", value: 5 },
      { key: "limit.public_api_requests", value: 50_000 },
    ],
  },
  {
    product: "growth",
    key: "growth-scale",
    name: "Growth Scale",
    description: "Higher limits, more channels and priority support.",
    amountMinor: 199_900,
    active: false,
    credits: 50_000_000,
    entitlements: [
      ...["inbox", "contacts", "bookings", "campaigns", "templates", "content", "analytics", "agents"].map((name) => ({
        key: `feature.${name === "campaigns" ? "campaigns.manage" : name === "templates" ? "templates.manage" : name === "content" ? "content.manage" : name === "analytics" ? "analytics.view" : name === "agents" ? "agents.manage" : `${name}.access`}`,
        value: true,
      })),
      { key: "feature.campaigns.send", value: true },
      { key: "feature.content.publish", value: true },
      { key: "limit.team_seats", value: 25 },
      { key: "limit.connected_channels", value: 15 },
      { key: "limit.campaign_recipients", value: 25_000 },
      { key: "limit.social_publishes", value: 500 },
      { key: "limit.agent_deployments", value: 25 },
      { key: "limit.public_api_requests", value: 250_000 },
    ],
  },
  {
    product: "agents",
    key: "agents-free",
    name: "Agents Free",
    description: "One agent and a small monthly token allowance.",
    amountMinor: 0,
    active: true,
    credits: 1_000_000,
    entitlements: [
      { key: "agents.feature.manage", value: true },
      { key: "limit.agent_tokens", value: 1_000_000 },
      { key: "limit.agent_count", value: 1, enforcement: "display_only" },
      { key: "limit.agent_channels", value: 1, enforcement: "display_only" },
    ],
  },
  {
    product: "agents",
    key: "agents-starter",
    name: "Agents Starter",
    description: "Three agents, two channels and a monthly AI allowance.",
    amountMinor: 49_900,
    active: false,
    credits: 10_000_000,
    entitlements: [
      { key: "agents.feature.manage", value: true },
      { key: "limit.agent_tokens", value: 10_000_000 },
      { key: "limit.agent_count", value: 3, enforcement: "display_only" },
      { key: "limit.agent_channels", value: 2, enforcement: "display_only" },
    ],
  },
  {
    product: "agents",
    key: "agents-growth",
    name: "Agents Growth",
    description: "Ten agents, five channels and a larger AI allowance.",
    amountMinor: 99_900,
    active: false,
    credits: 25_000_000,
    entitlements: [
      { key: "agents.feature.manage", value: true },
      { key: "limit.agent_tokens", value: 25_000_000 },
      { key: "limit.agent_count", value: 10, enforcement: "display_only" },
      { key: "limit.agent_channels", value: 5, enforcement: "display_only" },
    ],
  },
  {
    product: "agency",
    key: "agency-free",
    name: "Agency Free",
    description: "One client workspace and limited agent commands.",
    amountMinor: 0,
    active: true,
    credits: 0,
    entitlements: [
      { key: "agency.feature.agents", value: true },
      { key: "limit.agency_workspaces", value: 1, enforcement: "display_only" },
      { key: "limit.agency_staff", value: 1, enforcement: "display_only" },
      { key: "limit.agency_agent_commands", value: 1_000 },
    ],
  },
  {
    product: "agency",
    key: "agency-partner",
    name: "Agency Partner",
    description: "Ten client workspaces, five staff seats and a shared AI allowance.",
    amountMinor: 299_900,
    active: false,
    credits: 50_000_000,
    entitlements: [
      { key: "agency.feature.agents", value: true },
      { key: "limit.agency_workspaces", value: 10, enforcement: "display_only" },
      { key: "limit.agency_staff", value: 5, enforcement: "display_only" },
      { key: "limit.agency_agent_commands", value: 100_000 },
    ],
  },
];

async function seedCapabilities(client: PoolClient): Promise<void> {
  for (const capability of CAPABILITIES)
    await client.query(
      `INSERT INTO billing.capabilities(
         key, product, name, description, kind, unit, value_type,
         display_group, display_order, visible_to_customer,
         implementation_status, credit_cost_per_unit, credit_cost_minimum
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12)
       ON CONFLICT (key) DO NOTHING`,
      [
        capability.key,
        capability.product,
        capability.name,
        capability.description,
        capability.kind,
        capability.unit ?? null,
        capability.valueType,
        capability.displayGroup,
        capability.displayOrder,
        capability.implementationStatus,
        capability.creditCostPerUnit ?? null,
        capability.creditCostMinimum ?? "0",
      ],
    );
}

async function seedPlan(client: PoolClient, plan: SeedPlan): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM billing.plans WHERE key=$1`,
    [plan.key],
  );
  if (existing.rows[0]) return;
  const planId = `pln_${randomUUID()}`;
  const versionId = `plv_${randomUUID()}`;
  await client.query(
    `INSERT INTO billing.plans(id, product_key, key, name, description, status)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      planId,
      plan.product,
      plan.key,
      plan.name,
      plan.description,
      plan.active ? "active" : "draft",
    ],
  );
  await client.query(
    `INSERT INTO billing.plan_versions(
       id, plan_id, version, status, interval, currency, amount_minor,
       tax_inclusive, tax_rate_bps, credits_per_period, active, published_at, published_by
     ) VALUES($1,$2,1,$3,'monthly','ZAR',$4,true,1500,$5,$6,$7,$8)`,
    [
      versionId,
      planId,
      plan.active ? "active" : "draft",
      plan.amountMinor,
      plan.credits,
      plan.active,
      plan.active ? new Date() : null,
      plan.active ? "seed" : null,
    ],
  );
  for (const item of plan.entitlements)
    await client.query(
      `INSERT INTO billing.plan_entitlements(id, plan_version_id, key, value, metadata)
       VALUES($1,$2,$3,$4,$5)`,
      [
        `ple_${randomUUID()}`,
        versionId,
        item.key,
        JSON.stringify(item.value),
        JSON.stringify({
          ...(item.enforcement
            ? { enforcement: item.enforcement }
            : DISPLAY_ONLY_LIMITS.has(item.key)
              ? { enforcement: "display_only" }
              : {}),
          ...(item.visible === false ? { visible: false } : {}),
        }),
      ],
    );
}

export async function seed(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await transaction(pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('kasitek-billing-seed'))",
      );
      await seedCapabilities(client);
      for (const plan of PLANS) await seedPlan(client, plan);
      await client.query(
        `INSERT INTO billing.settings(key, value) VALUES('catalog_defaults_version','{"version":1}'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      );
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.BILLING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("BILLING_DATABASE_URL is required");
  await seed(url);
}
