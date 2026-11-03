import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp, type RouteRegistrar } from "../../src/app.js";
import { readConfig } from "../../src/config.js";
import { installPgTimestampParsers } from "../../src/db.js";
import { oauthDigest } from "../../src/oauth/index.js";
import { registerGrowthMcpRoutes } from "../../src/operations/mcp.js";
import { registerGrowthOperationRoutes } from "../../src/operations/routes.js";
import { uploadContentMediaBytes } from "../../src/services/social/media.js";
import { isolatedDatabase } from "./database-fixture.js";

/** Owned schema and bytes only; credentials authorize synthetic fixture records. */
export async function contentLibraryFixture(database: string, options: { publicUrl?: string; frontendUrl?: string; registrars?: RouteRegistrar[]; browserLogin?: boolean } = {}) {
  installPgTimestampParsers();
  const inventory = new pg.Pool({ connectionString: database });
  const omitted = new Set(["GrowthOperationReview", "GrowthMediaTransfer", "analytics_outbox", "ContentTemplate", "ContentTemplateMedia", "ContentTemplateMutation", "ContentMediaLibraryMutation"]);
  const tables = (await inventory.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename)
    .filter(name => /^[A-Za-z_]+$/.test(name) && !name.startsWith("GrowthOAuth") && !omitted.has(name));
  await inventory.end();
  const fixture = await isolatedDatabase(database, "content_library_runtime", tables);
  const directory = await mkdtemp(join(tmpdir(), "growth-library-owned-"));
  const publicUrl = options.publicUrl ?? "http://localhost:4105";
  const config = readConfig({ DATABASE_URL: database, ENVIRONMENT: "test", LOG_LEVEL: "silent", KASITEK_CORE_PUBLIC_URL: publicUrl,
    FRONTEND_URL: options.frontendUrl ?? "http://localhost:3012", GROWTH_AGENT_ACCESS_ENABLED: "true", GROWTH_AGENT_EFFECTS_ENABLED: "true",
    KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE: "10000", KASITEK_MEDIA_STORAGE_PATH: directory });
  const core = { pool: fixture.pool, config };
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await fixture.pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT; ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await fixture.pool.query(await readFile(new URL("../../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql", import.meta.url), "utf8"));
    for (const migration of ["20261101130000_growth_oauth.sql", "20261101140000_growth_operation_reviews.sql", "20261101150000_growth_media_transfers.sql", "20261102190000_content_agent_workflows.sql", "20261102200000_content_mcp_app_confirmation.sql", "20261102210000_content_requested_actions.sql", "20261103110000_content_media_library.sql", "20261103111000_content_templates.sql"])
      await fixture.pool.query(await readFile(new URL(`../../sql/${migration}`, import.meta.url), "utf8"));
    await fixture.pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('library-user','Library fixture','library@example.test',now(),now(),now()),('foreign-user','Other fixture','foreign@example.test',now(),now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('library-org','Library fixture','library-fixture','library-user',now(),now()),('foreign-org','Other fixture','foreign-fixture','foreign-user',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('library-member','library-org','library-user','OWNER',now()),('foreign-member','foreign-org','foreign-user','OWNER',now());
      INSERT INTO "OrganizationOnboardingProfile"(id,"orgId","primaryGoals","completedAt","updatedAt") VALUES('library-profile','library-org',ARRAY['content'],now(),now());
      INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","updatedAt") VALUES('fixture-facebook','library-user','library-org','FACEBOOK','CONNECTED','Fixture Page','synthetic-no-provider-token',now());
      INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris") VALUES('library-client','Library fixture',ARRAY['http://localhost/callback']);`);
    const token = "growth_oauth_" + randomBytes(32).toString("base64url");
    const apiKey = "kst_" + randomBytes(32).toString("base64url");
    await fixture.pool.query(`INSERT INTO "DeveloperApiKey"(id,"orgId",name,prefix,"keyHash",scopes,status,"createdById","createdAt","updatedAt") VALUES('library-key','library-org','Library fixture key','kst_fixture',$1,ARRAY['growth:read','growth:draft','growth:manage'],'ACTIVE','library-user',now(),now())`, [oauthDigest(apiKey)]);
    const session = "library-fixture-" + randomBytes(24).toString("hex");
    await fixture.pool.query(`INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES('library-oauth','library-client','library-user','library-org',$1,ARRAY['growth:read','growth:draft','growth:manage'],$2,now()+interval '1 day')`, [publicUrl + "/mcp", oauthDigest(token)]);
    await fixture.pool.query(`INSERT INTO "Session"(id,"sessionToken","userId","refreshToken","idToken",expires,"identityCheckedAt","providerRefreshedAt","lastActivityAt") VALUES('library-session',$1,'library-user','unused','unused',now()+interval '1 day',now()+interval '1 day',now()+interval '1 day',now())`, [oauthDigest(session)]);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const asset = await uploadContentMediaBytes(fixture.pool, config, "library-user", "library-org", { bytes: image, mimeType: "image/png", fileName: "Fixture image.png", source: "owned-library-fixture" });
    const foreignAsset = await uploadContentMediaBytes(fixture.pool, config, "foreign-user", "foreign-org", { bytes: image, mimeType: "image/png", fileName: "Other image.png", source: "owned-library-fixture" });
    const registrars = options.registrars ?? [registerGrowthOperationRoutes, registerGrowthMcpRoutes];
    app = await buildApp(core, [...registrars, ...(options.browserLogin ? [(server => {
      server.get("/api/test-fixture/login", async (_request, reply) => reply.setCookie("kasitek_session", session, { path: "/", httpOnly: true, sameSite: "lax" }).setCookie("kasitek_active_org", "library-org", { path: "/", sameSite: "lax" }).redirect("/content/templates"));
    }) as RouteRegistrar] : [])]);
    return { ...core, app, token, apiKey, session, asset, foreignAsset, directory, async close() { await app?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await app?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
