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
  { key: "growth_ai_cost", product: "growth", name: "AI usage", description: "Managed model cost settled by Growth workspace agents, in micro-USD.", kind: "meter", unit: "micro_usd", valueType: "decimal", displayGroup: "Usage", displayOrder: 4, implementationStatus: "implemented", creditCostPerUnit: "1", creditCostMinimum: "0" },
  { key: "growth_agent_tokens", product: "growth", name: "AI tokens", description: "Accounted model tokens for Growth workspace agents.", kind: "meter", unit: "token", valueType: "decimal", displayGroup: "Usage", displayOrder: 5, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  // Agents
  { key: "agents.feature.manage", product: "agents", name: "Agents workspace", description: "Create and run standalone customer-service agents.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 10, implementationStatus: "implemented" },
  { key: "agents.feature.handoff", product: "agents", name: "Human handoff", description: "Let agents hand conversations to staff in the shared inbox.", kind: "feature", valueType: "boolean", displayGroup: "Inbox", displayOrder: 20, implementationStatus: "implemented" },
  { key: "agents.feature.assignment", product: "agents", name: "Inbox assignment", description: "Assign conversations to teammates.", kind: "feature", valueType: "boolean", displayGroup: "Inbox", displayOrder: 30, implementationStatus: "implemented" },
  { key: "agents.feature.analytics", product: "agents", name: "Inbox analytics", description: "See handoff and response performance.", kind: "feature", valueType: "boolean", displayGroup: "Inbox", displayOrder: 40, implementationStatus: "implemented" },
  { key: "agents.feature.branding", product: "agents", name: "Remove KasiTek badge", description: "Hide the Powered by KasiTek footer on website widgets.", kind: "feature", valueType: "boolean", displayGroup: "Branding", displayOrder: 10, implementationStatus: "implemented" },
  { key: "agent_ai_cost", product: "agents", name: "AI usage", description: "Managed model cost settled by agent tasks, in micro-USD.", kind: "meter", unit: "micro_usd", valueType: "decimal", displayGroup: "Usage", displayOrder: 5, implementationStatus: "implemented", creditCostPerUnit: "1", creditCostMinimum: "0" },
  { key: "agent_tokens", product: "agents", name: "Agent tokens", description: "Accounted model tokens settled by agent tasks.", kind: "meter", unit: "token", valueType: "decimal", displayGroup: "Usage", displayOrder: 10, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  { key: "limit.agent_seats", product: "agents", name: "Team seats", description: "Active team members in the Agents workspace.", kind: "limit", unit: "seats", valueType: "integer", displayGroup: "Team", displayOrder: 5, implementationStatus: "implemented" },
  { key: "limit.agent_tokens", product: "agents", name: "Monthly agent tokens", description: "Accounted tokens per month.", kind: "limit", unit: "tokens", valueType: "integer", displayGroup: "Limits", displayOrder: 10, implementationStatus: "implemented" },
  { key: "limit.crawl_pages", product: "agents", name: "Website crawl pages", description: "Website pages discovered by the crawler per month.", kind: "limit", unit: "pages", valueType: "integer", displayGroup: "Knowledge", displayOrder: 15, implementationStatus: "implemented" },
  { key: "limit.agent_count", product: "agents", name: "Agents", description: "Active agent definitions.", kind: "limit", unit: "agents", valueType: "integer", displayGroup: "Limits", displayOrder: 20, implementationStatus: "implemented" },
  { key: "limit.agent_channels", product: "agents", name: "Agent channels", description: "Connected agent channels.", kind: "limit", unit: "channels", valueType: "integer", displayGroup: "Limits", displayOrder: 30, implementationStatus: "implemented" },
  // Agency
  { key: "agency.feature.agents", product: "agency", name: "Agency agents", description: "Configure and run agents for Agency client workspaces.", kind: "feature", valueType: "boolean", displayGroup: "Features", displayOrder: 10, implementationStatus: "implemented" },
  { key: "agency_agent_commands", product: "agency", name: "Agency agent commands", description: "Accepted agent commands for client workspaces.", kind: "meter", unit: "command", valueType: "integer", displayGroup: "Usage", displayOrder: 10, implementationStatus: "implemented", creditCostPerUnit: "0", creditCostMinimum: "0" },
  { key: "limit.agency_workspaces", product: "agency", name: "Client workspaces", description: "Active client workspaces.", kind: "limit", unit: "workspaces", valueType: "integer", displayGroup: "Limits", displayOrder: 10, implementationStatus: "product_pending" },
  { key: "limit.agency_staff", product: "agency", name: "Partner staff seats", description: "Partner staff seats.", kind: "limit", unit: "seats", valueType: "integer", displayGroup: "Limits", displayOrder: 20, implementationStatus: "product_pending" },
  { key: "limit.agency_agent_commands", product: "agency", name: "Monthly agent commands", description: "Accepted agent commands per month.", kind: "limit", unit: "commands", valueType: "integer", displayGroup: "Limits", displayOrder: 30, implementationStatus: "implemented" },
];

const DISPLAY_ONLY_LIMITS = new Set([
  "limit.agent_deployments",
  "limit.agency_workspaces",
  "limit.agency_staff",
]);

export interface SeedPlan {
  product: ProductKey;
  key: string;
  name: string;
  description: string;
  amountMinor: number;
  active: boolean;
  audience?: "public" | "sandbox";
  credits: number | null;
  entitlements: Array<{
    key: string;
    value: unknown;
    enforcement?: "hard" | "soft" | "display_only";
    visible?: boolean;
  }>;
}

const GROWTH_PAID_FEATURES = [
  "feature.inbox.access",
  "feature.contacts.access",
  "feature.bookings.access",
  "feature.campaigns.manage",
  "feature.campaigns.send",
  "feature.templates.manage",
  "feature.content.manage",
  "feature.content.publish",
  "feature.analytics.view",
  "feature.agents.manage",
];

const AGENTS_ALL_FEATURES = [
  "agents.feature.manage",
  "agents.feature.handoff",
  "agents.feature.assignment",
  "agents.feature.analytics",
  "agents.feature.branding",
];

const growthPlan = (
  key: string,
  name: string,
  description: string,
  amountMinor: number,
  active: boolean,
  credits: number | null,
  seats: number,
  channels: number,
  recipients: number,
  social: number,
  api: number,
  features: string[],
): SeedPlan => ({
  product: "growth",
  key,
  name,
  description,
  amountMinor,
  active,
  credits,
  entitlements: [
    ...features.map((feature) => ({ key: feature, value: true })),
    { key: "limit.team_seats", value: seats },
    { key: "limit.connected_channels", value: channels },
    { key: "limit.campaign_recipients", value: recipients },
    { key: "limit.social_publishes", value: social },
    { key: "limit.public_api_requests", value: api },
  ],
});

const agentsPlan = (
  key: string,
  name: string,
  description: string,
  amountMinor: number,
  active: boolean,
  credits: number | null,
  seats: number,
  agents: number,
  channels: number,
  crawlPages: number,
  features: string[],
): SeedPlan => ({
  product: "agents",
  key,
  name,
  description,
  amountMinor,
  active,
  credits,
  entitlements: [
    ...features.map((feature) => ({ key: feature, value: true })),
    { key: "limit.agent_seats", value: seats },
    { key: "limit.agent_count", value: agents },
    { key: "limit.agent_channels", value: channels },
    { key: "limit.crawl_pages", value: crawlPages },
  ],
});

export const PLANS: SeedPlan[] = [
  growthPlan(
    "growth-free",
    "Free",
    "Inbox, contacts, calls and bookings for one person.",
    0,
    true,
    0,
    1,
    1,
    0,
    0,
    1_000,
    [
      "feature.inbox.access",
      "feature.contacts.access",
      "feature.bookings.access",
      "feature.templates.manage",
    ],
  ),
  growthPlan(
    "growth-entry",
    "Starter",
    "Campaigns, content and workspace agents for a small team.",
    35_000,
    false,
    10_000_000,
    3,
    2,
    1_000,
    50,
    10_000,
    GROWTH_PAID_FEATURES,
  ),
  growthPlan(
    "growth-mid",
    "Growth",
    "More volume, analytics and priority support for a growing team.",
    99_900,
    false,
    25_000_000,
    10,
    5,
    5_000,
    200,
    50_000,
    GROWTH_PAID_FEATURES,
  ),
  growthPlan(
    "growth-scale",
    "Scale",
    "High volume, more channels and onboarding for a larger operation.",
    199_900,
    false,
    60_000_000,
    25,
    15,
    25_000,
    750,
    250_000,
    GROWTH_PAID_FEATURES,
  ),
  agentsPlan(
    "agents-free",
    "Free",
    "One agent and one channel with a small AI allowance.",
    0,
    true,
    1_000_000,
    1,
    1,
    1,
    0,
    ["agents.feature.manage"],
  ),
  agentsPlan(
    "agents-starter",
    "Starter",
    "Three agents, human handoff and a small website crawl allowance.",
    35_000,
    false,
    10_000_000,
    3,
    3,
    2,
    100,
    ["agents.feature.manage", "agents.feature.handoff"],
  ),
  agentsPlan(
    "agents-growth",
    "Growth",
    "Ten agents, inbox assignment and unbranded website widgets.",
    99_900,
    false,
    25_000_000,
    10,
    10,
    5,
    500,
    AGENTS_ALL_FEATURES,
  ),
  agentsPlan(
    "agents-scale",
    "Scale",
    "More agents, channels, crawl pages and AI usage.",
    199_900,
    false,
    60_000_000,
    25,
    25,
    10,
    2_000,
    AGENTS_ALL_FEATURES,
  ),
  agentsPlan(
    "agents-reseller",
    "Reseller",
    "Build and host agents for clients with unbranded widgets.",
    499_900,
    false,
    150_000_000,
    50,
    50,
    25,
    5_000,
    AGENTS_ALL_FEATURES,
  ),
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
    product: "growth",
    key: "growth-sandbox-unlimited",
    name: "Growth sandbox unlimited",
    description: "Internal evaluation entitlement. Not a customer plan.",
    amountMinor: 0,
    active: true,
    audience: "sandbox",
    credits: 1_000_000_000_000,
    entitlements: [
      ...GROWTH_PAID_FEATURES.map((key) => ({ key, value: true })),
      { key: "limit.team_seats", value: null },
      { key: "limit.connected_channels", value: null },
      { key: "limit.campaign_recipients", value: null },
      { key: "limit.social_publishes", value: null },
      { key: "limit.agent_deployments", value: null },
      { key: "limit.public_api_requests", value: null },
    ],
  },
  {
    product: "agents",
    key: "agents-sandbox-unlimited",
    name: "Agents sandbox unlimited",
    description: "Internal evaluation entitlement. Not a customer plan.",
    amountMinor: 0,
    active: true,
    audience: "sandbox",
    credits: 1_000_000_000_000,
    entitlements: [
      ...AGENTS_ALL_FEATURES.map((key) => ({ key, value: true })),
      { key: "limit.agent_seats", value: null },
      { key: "limit.agent_tokens", value: null },
      { key: "limit.crawl_pages", value: null },
      { key: "limit.agent_count", value: null },
      { key: "limit.agent_channels", value: null },
    ],
  },
  {
    product: "agency",
    key: "agency-sandbox-unlimited",
    name: "Agency sandbox unlimited",
    description: "Internal evaluation entitlement. Not a customer plan.",
    amountMinor: 0,
    active: true,
    audience: "sandbox",
    credits: 1_000_000_000_000,
    entitlements: [
      { key: "agency.feature.agents", value: true },
      { key: "limit.agency_workspaces", value: null },
      { key: "limit.agency_staff", value: null },
      { key: "limit.agency_agent_commands", value: null },
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
    `INSERT INTO billing.plans(id, product_key, key, name, description, status, audience)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      planId,
      plan.product,
      plan.key,
      plan.name,
      plan.description,
      plan.active ? "active" : "draft",
      plan.audience ?? "public",
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
