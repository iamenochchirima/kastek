import "dotenv/config";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createPool, transaction } from "./db.js";

const GROWTH_FEATURES = [
  ["feature.agents.manage", "AI agents", "Create, configure, and deploy workspace agents."],
  ["feature.campaigns.manage", "Campaigns", "Create and manage customer messaging campaigns."],
  ["feature.campaigns.send", "Campaign sending", "Launch campaigns and send messages to recipients."],
  ["feature.bookings.access", "Bookings", "Manage booking services and appointments."],
  ["feature.templates.manage", "Message templates", "Create and manage reusable provider message templates."],
  ["feature.contacts.access", "Contacts", "Access and manage customer records."],
  ["feature.content.manage", "Content workspace", "Plan, create, schedule, and manage multi-platform content."],
  ["feature.content.publish", "Content publishing", "Publish approved content to connected social accounts."],
  ["feature.analytics.view", "Analytics", "View workspace, campaign, and connected-channel analytics."],
  ["feature.inbox.access", "Shared inbox", "Access connected customer conversations in one inbox."],
] as const;

const GROWTH_METERS = [
  ["agent_deployments", "Agent deployments", "Agent deployment operations during the current month."],
  ["campaign_recipients", "Campaign recipients", "Recipients processed by campaigns during the current month."],
  ["social_publishes", "Published content", "Social publishing operations during the current month."],
  ["public_api_requests", "Public API requests", "Authenticated public API requests during the current month."],
] as const;

async function seedCapabilities(client: PoolClient): Promise<void> {
  for (const [key, name, description] of GROWTH_FEATURES)
    await client.query(
      `INSERT INTO billing.capabilities(key, product, name, description, kind)
       VALUES($1,'growth',$2,$3,'feature')
       ON CONFLICT (key) DO NOTHING`,
      [key, name, description],
    );
  for (const [key, name, description] of GROWTH_METERS)
    await client.query(
      `INSERT INTO billing.capabilities(key, product, name, description, kind, unit)
       VALUES($1,'growth',$2,$3,'meter',$1)
       ON CONFLICT (key) DO NOTHING`,
      [key, name, description],
    );
  await client.query(
    `INSERT INTO billing.capabilities(key, product, name, description, kind)
     VALUES('agents.feature.manage','agents','Agents workspace','Create and run standalone customer-service agents.','feature')
     ON CONFLICT (key) DO NOTHING`,
  );
  await client.query(
    `INSERT INTO billing.capabilities(key, product, name, description, kind, unit)
     VALUES('agent_tokens','agents','Agent tokens','Accounted model tokens settled by agent tasks.','meter','token')
     ON CONFLICT (key) DO NOTHING`,
  );
  await client.query(
    `INSERT INTO billing.capabilities(key, product, name, description, kind)
     VALUES('agency.feature.agents','agency','Agency agents','Configure and run agents for Agency client workspaces.','feature')
     ON CONFLICT (key) DO NOTHING`,
  );
  await client.query(
    `INSERT INTO billing.capabilities(key, product, name, description, kind, unit)
     VALUES('agency_agent_commands','agency','Agency agent commands','Accepted agent commands for Agency client workspaces.','meter','command')
     ON CONFLICT (key) DO NOTHING`,
  );
}

async function seedPlan(
  client: PoolClient,
  input: {
    product: "growth" | "agents" | "agency";
    key: string;
    name: string;
    amountMinor: number;
    active: boolean;
    credits: number | null;
    entitlements: Array<[string, unknown]>;
  },
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM billing.plans WHERE key=$1`,
    [input.key],
  );
  if (existing.rows[0]) return;
  const planId = `pln_${randomUUID()}`;
  const versionId = `plv_${randomUUID()}`;
  await client.query(
    `INSERT INTO billing.plans(id, product_key, key, name, status)
     VALUES($1,$2,$3,$4,$5)`,
    [
      planId,
      input.product,
      input.key,
      input.name,
      input.active ? "active" : "draft",
    ],
  );
  await client.query(
    `INSERT INTO billing.plan_versions(
       id, plan_id, version, interval, currency, amount_minor,
       tax_inclusive, tax_rate_bps, credits_per_period, active
     ) VALUES($1,$2,1,'monthly','ZAR',$3,true,1500,$4,$5)`,
    [versionId, planId, input.amountMinor, input.credits, input.active],
  );
  for (const [key, value] of input.entitlements)
    await client.query(
      `INSERT INTO billing.plan_entitlements(id, plan_version_id, key, value)
       VALUES($1,$2,$3,$4)`,
      [`ple_${randomUUID()}`, versionId, key, JSON.stringify(value)],
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
      await seedPlan(client, {
        product: "growth",
        key: "growth-free",
        name: "Free",
        amountMinor: 0,
        active: true,
        credits: 0,
        entitlements: [
          ["feature.inbox.access", true],
          ["feature.contacts.access", true],
          ["feature.bookings.access", true],
          ["limit.agent_deployments", 0],
          ["limit.campaign_recipients", 0],
          ["limit.social_publishes", 0],
          ["limit.public_api_requests", 1000],
        ],
      });
      await seedPlan(client, {
        product: "growth",
        key: "growth-entry",
        name: "Growth",
        amountMinor: 35_000,
        active: false,
        credits: 5_000,
        entitlements: [],
      });
      await seedPlan(client, {
        product: "agents",
        key: "agents-free",
        name: "Agents Free",
        amountMinor: 0,
        active: true,
        credits: 0,
        entitlements: [
          ["agents.feature.manage", true],
          ["limit.agent_tokens", 2_000_000],
        ],
      });
      await seedPlan(client, {
        product: "agency",
        key: "agency-free",
        name: "Agency Free",
        amountMinor: 0,
        active: true,
        credits: 0,
        entitlements: [
          ["agency.feature.agents", true],
          ["limit.agency_agent_commands", 10_000],
        ],
      });
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
