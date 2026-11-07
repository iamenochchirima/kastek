import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { installPgTimestampParsers } from "../../src/db.js";
import { registerGrowthOperationRoutes } from "../../src/operations/routes.js";
import { oauthDigest } from "../../src/oauth/index.js";
import { ApiError } from "../../src/error.js";
import { growthAgentPublication, growthAgentPublicationV5 } from "../../src/agents/manifest.js";
import { registerGrowthAgentActionRoutes } from "../../src/agents/action-routes.js";
import { registerGrowthAgentRoutes } from "../../src/agents/routes.js";
import { growthAgentActor } from "../../src/agents/security.js";
import { authorizeGrowthAgentScope } from "../../src/agents/scope.js";
import { getSocialPost, listSocialPosts } from "../../src/services/social/posts.js";
import { growthAgentSocialFixture } from "../growth-agent-fixture.js";

// Separate process and database: the Agents integration suite calls public HTTP boundaries only.
const database = `growth_agents_e2e_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool | undefined, pool: pg.Pool | undefined, app: FastifyInstance | undefined, created = false;
let shutdownPromise: Promise<void> | undefined;
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const required = (name: string): string => {
  const value = process.env[name]; if (!value?.trim()) throw new Error(`Missing fixture setting ${name}`); return value;
};
function localOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Fixture service must use a loopback HTTP origin");
  return url.origin;
}
async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try { app?.server.closeAllConnections(); await app?.close(); } finally {
      try { await pool?.end(); } finally {
        try {
          if (created && admin && /^growth_agents_e2e_[a-f0-9]{32}$/.test(database)) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        } finally { await admin?.end(); }
      }
    }
  })();
  return shutdownPromise;
}
async function start() {
  if (process.env.NODE_ENV !== "test") throw new Error("Growth fixture requires NODE_ENV=test");
  const adminUrl = new URL(required("GROWTH_AGENT_FIXTURE_ADMIN_URL"));
  if (!["postgres:", "postgresql:"].includes(adminUrl.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname)) throw new Error("Growth fixture requires an explicit loopback PostgreSQL administrator");
  const tenantId = required("GROWTH_AGENT_FIXTURE_TENANT_ID"), userId = required("GROWTH_AGENT_FIXTURE_USER_ID");
  if (tenantId.length > 256 || userId.length > 512) throw new Error("Invalid fixture identity");
  required("GROWTH_AGENTS_SIGNING_PRIVATE_KEY"); required("AGENTS_PRODUCT_ACTION_PUBLIC_KEY");
  admin = new pg.Pool({ connectionString: adminUrl.href });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  const scoped = new URL(adminUrl); scoped.pathname = `/${database}`;
  installPgTimestampParsers(); pool = new pg.Pool({ connectionString: scoped.href, max: 10, options: "-c timezone=UTC" });
  await pool.query(`CREATE TABLE "User"(id text PRIMARY KEY,"emailVerified" timestamptz,name text,email text,phone text,image text,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());
    CREATE TABLE "Organization"(id text PRIMARY KEY,name text,"reportingTimezone" text,"updatedAt" timestamptz DEFAULT now(),slug text,logo text,"ownerId" text,"createdAt" timestamptz DEFAULT now());
    CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text,PRIMARY KEY("orgId","userId"));
    CREATE TABLE "OrganizationOnboardingProfile"("orgId" text,website text,industry text,"primaryGoal" text,"primaryGoals" text[]);
    CREATE TYPE "OrganizationSubscriptionStatus" AS ENUM('TRIAL','ACTIVE','GRACE','CANCELED');
    CREATE TABLE "OrganizationEntitlementGrant"("orgId" text,key text,value jsonb,"startsAt" timestamptz,"endsAt" timestamptz);
    CREATE TABLE "OrganizationSubscription"("orgId" text,"planId" text,status "OrganizationSubscriptionStatus");
    CREATE TABLE "PlanEntitlement"("planId" text,key text,value jsonb);`);
  await pool.query('INSERT INTO "User"(id,"emailVerified") VALUES($1,now())', [userId]);
  await pool.query('INSERT INTO "Organization"(id,name,"reportingTimezone") VALUES($1,\'Fixture business\',\'UTC\')', [tenantId]);
  await pool.query('INSERT INTO "OrganizationMember" VALUES($1,$2,\'OWNER\')', [tenantId, userId]);
  await pool.query(`INSERT INTO "OrganizationEntitlementGrant"("orgId",key,value,"startsAt")
    SELECT $1,key,'true'::jsonb,now() FROM unnest(ARRAY['feature.agents.manage','feature.content.manage','feature.campaigns.manage']) key`, [tenantId]);
  await pool.query(growthAgentSocialFixture);
  await pool.query(`CREATE TABLE "Conversation"(id text PRIMARY KEY);
    CREATE TABLE "ExternalConnection"(id text PRIMARY KEY);
    CREATE TABLE "WhatsappContact"(id text PRIMARY KEY);
    CREATE TABLE "WhatsappContactListMembership"(id text PRIMARY KEY);`);
  await pool.query(await readFile(new URL("../../../database/prisma/migrations/20261103120000_agent_review_row_versions/migration.sql",import.meta.url),"utf8"));
  await pool.query(`CREATE TABLE "Session"(id text PRIMARY KEY,"sessionToken" text,"userId" text,expires timestamptz,"refreshToken" text,"idToken" text,"lastActivityAt" timestamptz,"identityCheckedAt" timestamptz,"providerRefreshedAt" timestamptz);
    CREATE TABLE "PublicApiRequest"(id text PRIMARY KEY,"orgId" text,"principalType" text,"principalId" text,route text,method text,"statusCode" integer,"correlationId" text,action text,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE "UsageEvent"(id text PRIMARY KEY,"orgId" text,"productKey" text,"metricKey" text,quantity bigint,"sourceType" text,"sourceId" text,"idempotencyKey" text,metadata jsonb);
    CREATE TABLE "PublicApiWebhookSubscription"(id text,"orgId" text,status text,events text[]);
    CREATE TABLE "SocialPostVariantMedia"(id text PRIMARY KEY,"variantId" text,"assetId" text,"sortOrder" integer,"altText" text,metadata jsonb);`);
  await pool.query(`INSERT INTO "Session" VALUES('fixture-session',$1,$2,now()+interval '1 day','unused','unused',now(),now(),now())`,[oauthDigest("fixture-dashboard-session"),userId]);
  await pool.query(await readFile(new URL("../../sql/20261101140000_growth_operation_reviews.sql",import.meta.url),"utf8"));

  await pool.query(await readFile(new URL("../../../database/prisma/migrations/20261023183000_growth_agent_source_handles/migration.sql",import.meta.url),"utf8"));
  await pool.query(await readFile(new URL("../../../database/prisma/migrations/20261103100000_growth_read_access_handles/migration.sql",import.meta.url),"utf8"));
  await pool.query(`UPDATE "SocialChannelConnection" SET id='fixture-account',"orgId"=$1,"userId"=$2,"displayName"='Fixture Facebook account' WHERE id='channel'`, [tenantId, userId]);
  await pool.query(`UPDATE "ContentMediaAsset" SET "orgId"=$1 WHERE "orgId"='org'`, [tenantId]);
  await pool.query(await readFile(new URL("../../../database/prisma/migrations/20261023010000_growth_agent_reviews/migration.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../../database/prisma/migrations/20261023170000_growth_agent_setup/migration.sql", import.meta.url), "utf8"));
  // This fixture's Agents side explicitly provisions its model before any browser request.
  await pool.query(`INSERT INTO "GrowthAgentSetup" ("orgId","requestId","modelProfileId","modelProfileRevision",status,"completedAt") VALUES($1,$2,'fixture','1','ready',NOW())`, [tenantId, randomUUID()]);
  const config = readConfig({ ...process.env, DATABASE_URL: scoped.href, ENVIRONMENT: "test", LOG_LEVEL: "silent", FRONTEND_URL: "http://localhost:3000" });
  if (config.env.AGENTS_PRODUCT_API_URL) config.env.AGENTS_PRODUCT_API_URL = localOrigin(config.env.AGENTS_PRODUCT_API_URL);
  const core = { config, pool }, scope = { tenantId, actor: growthAgentActor(config, userId) };
  app = await buildApp(core, [
    registerGrowthAgentActionRoutes,
    registerGrowthOperationRoutes,
    (server, context) => registerGrowthAgentRoutes(server, context, { resolveScope: async () => scope }),
  ]);
  // Only this isolated fixture supplies the dashboard identity. Agent routes remain real.
  app.get("/api/auth/me", async () => ({ user: { id: userId, name: "Fixture operator", email: "operator@growth.fixture.test", image: "", emailVerified: new Date().toISOString() } }));
  app.get("/api/orgs", async () => ({ orgs: [{ id: tenantId, name: "Fixture business", slug: "fixture", logo: null, ownerId: userId }] }));
  app.get("/api/onboarding", async () => ({ needsOnboarding: false, canManage: true, profile: {} }));
  app.get("/api/product-tour", async () => ({ shouldShow: false, currentStep: 0 }));
  app.get("/api/whatsapp/inbox/unread-count", async () => ({ unreadCount: 0 }));
  app.get("/api/early-access/status", async () => ({ earlyAccess: null }));
  app.post("/api/auth/activity", async () => ({ ok: true }));
  app.get("/__fixture/posts", async () => {
    await authorizeGrowthAgentScope(core, scope, "content");
    return { posts: await listSocialPosts(pool!, tenantId) };
  });
  app.get("/__fixture/posts/:postId", async request => {
    await authorizeGrowthAgentScope(core, scope, "content");
    const id = (request.params as { postId: string }).postId, post = await getSocialPost(pool!, tenantId, id);
    if (!post) throw new ApiError(404, "not_found", "Post not found"); return { post };
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  config.frontendUrl = address;
  emit({ type: "ready", port: Number(new URL(address).port), tenantId, userId, allowedOrigin: address, publication: growthAgentPublicationV5, canonicalPublication: growthAgentPublication });
  return { core, scope };
}
const startup = start();
const stop = async () => { await startup.catch(() => undefined); await shutdown(); };
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
try {
  const { core, scope } = await startup;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 16384) throw new Error("Fixture control message is too large");
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "configure" && (typeof message.agentsOrigin === "string" || typeof message.frontendOrigin === "string") &&
      Object.keys(message).every(key => ["type", "agentsOrigin", "frontendOrigin"].includes(key))) {
      if (message.agentsOrigin !== undefined) {
        if (typeof message.agentsOrigin !== "string") throw new Error("Invalid fixture Agents origin");
        core.config.env.AGENTS_PRODUCT_API_URL = localOrigin(message.agentsOrigin);
        core.config.rawEnv.AGENTS_PRODUCT_API_URL = core.config.env.AGENTS_PRODUCT_API_URL;
      }
      if (message.frontendOrigin !== undefined) {
        if (typeof message.frontendOrigin !== "string") throw new Error("Invalid fixture frontend origin");
        core.config.frontendUrl = localOrigin(message.frontendOrigin);
      }
      emit({ type: "configured" });
    } else if (message.type === "membership" && typeof message.enabled === "boolean" && Object.keys(message).every(key => ["type", "enabled"].includes(key))) {
      if (message.enabled) await core.pool.query('INSERT INTO "OrganizationMember" VALUES($1,$2,\'OWNER\') ON CONFLICT DO NOTHING', [scope.tenantId, scope.actor.subject]);
      else await core.pool.query('DELETE FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2', [scope.tenantId, scope.actor.subject]);
      emit({ type: "membership", enabled: message.enabled });
    } else if (message.type === "selected-post" && Object.keys(message).length === 1) {
      await core.pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",title,content,channels,status,"createdAt","updatedAt")
        VALUES('selected-post',$1,$2,'Selected fixture post','A real selected post.',ARRAY['FACEBOOK']::"SocialPlatform"[],'DRAFT',now(),now()),
          ('other-post','other-user','other-org','Other post','Private other post.',ARRAY['FACEBOOK']::"SocialPlatform"[],'DRAFT',now(),now()) ON CONFLICT DO NOTHING`,[scope.actor.subject,scope.tenantId]);
      emit({type:"selected-post"});
    } else if (message.type === "content-entitlement" && typeof message.enabled === "boolean" && Object.keys(message).every(key => ["type", "enabled"].includes(key))) {
      await core.pool.query('UPDATE "OrganizationEntitlementGrant" SET value=$2::jsonb WHERE "orgId"=$1 AND key=\'feature.content.manage\'', [scope.tenantId,JSON.stringify(message.enabled)]);
      emit({type:"content-entitlement",enabled:message.enabled});
    } else if (message.type === "profile" && typeof message.name === "string" && message.name.length <= 128 && Object.keys(message).every(key => ["type", "name"].includes(key))) {
      await core.pool.query('UPDATE "Organization" SET name=$2,"updatedAt"=now() WHERE id=$1',[scope.tenantId,message.name]);
      emit({type:"profile"});
    } else if (message.type === "shutdown" && Object.keys(message).length === 1) {
      lines.close(); break;
    } else throw new Error("Unknown fixture control message");
  }
  await shutdown();
} catch (error) {
  const failure = error as { name?: string; code?: string };
  process.stderr.write(`Growth fixture failed (${failure.name ?? "Error"}${failure.code && /^[A-Z0-9_]+$/.test(failure.code) ? `:${failure.code}` : ""})\n`);
  try { await shutdown(); } finally { process.exitCode = 1; }
}
