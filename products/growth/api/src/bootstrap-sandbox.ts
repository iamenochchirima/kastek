import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import pg from "pg";
import { growthAgentPublication } from "./agents/manifest.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const environment = (process.env.ENVIRONMENT ?? process.env.NODE_ENV ?? "development").trim().toLowerCase();
  if (environment === "production" || environment === "prod") {
    throw new Error("Growth sandbox bootstrap is unavailable in production");
  }
  const databaseUrl = required("DATABASE_URL");
  const email = required("GROWTH_BOOTSTRAP_EMAIL");
  const workspaceName = required("GROWTH_BOOTSTRAP_WORKSPACE_NAME");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const userId = createId();
  const organizationId = createId();
  const memberId = createId();
  const profileId = createId();
  const sessionId = createId();
  const setupRequestId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO "User" (id,name,email,"emailVerified","createdAt","updatedAt")
       VALUES ($1,$2,$3,NOW(),NOW(),NOW())`,
      [userId, process.env.GROWTH_BOOTSTRAP_DISPLAY_NAME?.trim() || "Sandbox owner", email],
    );
    await pool.query(
      `INSERT INTO "Organization" (id,name,slug,"ownerId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,NOW(),NOW())`,
      [organizationId, workspaceName, `sandbox-${organizationId}`, userId],
    );
    await pool.query(
      `INSERT INTO "OrganizationMember" (id,"orgId","userId",role,"joinedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'OWNER'::"OrgRole",NOW(),NOW(),NOW())`,
      [memberId, organizationId, userId],
    );
    await pool.query(
      `INSERT INTO "BusinessProfile" (id,"userId","businessName","businessType",country,"onboardingCompleted","createdAt","updatedAt")
       VALUES ($1,$2,$3,'sandbox','ZA',true,NOW(),NOW())`,
      [profileId, userId, workspaceName],
    );
    await pool.query(
      `INSERT INTO "GrowthAgentSetup" ("orgId","requestId","modelProfileId","modelProfileRevision","defaultsRevision")
       VALUES ($1,$2,$3,$4,$5)`,
      [
        organizationId,
        setupRequestId,
        process.env.GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_ID?.trim() || "growth-default",
        process.env.GROWTH_AGENTS_DEFAULT_MODEL_PROFILE_REVISION?.trim() || "1",
        growthAgentPublication.manifest.revision,
      ],
    );
    await pool.query(
      `INSERT INTO "Session" (id,"sessionToken","userId",expires,"lastActivityAt","identityCheckedAt","providerRefreshedAt","refreshToken","idToken")
       VALUES ($1,$2,$3,$4,NOW(),$5,$5,'sandbox-bootstrap-refresh','sandbox-bootstrap-id-token')`,
      [sessionId, tokenHash, userId, expiresAt, expiresAt],
    );
    await pool.query("COMMIT");
    process.stdout.write(JSON.stringify({
      userId,
      organizationId,
      organizationName: workspaceName,
      session: token,
      expiresAt: expiresAt.toISOString(),
      agentSetupRequestId: setupRequestId,
    }));
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
