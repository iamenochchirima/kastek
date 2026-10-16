import { createId } from "@paralleldrive/cuid2";
import type { CoreContext } from "../../context.js";
import { ApiError } from "../../error.js";
import * as orgs from "../orgs.js";
import { trialSettings } from "../org-support.js";
export interface LaunchUserRequest {
  name: string;
  email: string;
  workspaceName: string;
}
const notFound = () =>
  new ApiError(404, "not_found", "Launch invitation not found");
export async function listLaunchAccess(core: CoreContext) {
  const result = await core.pool.query(
    `SELECT i.id, i.email, i.role::text AS role, i."expiresAt", i."acceptedAt", i."revokedAt", i."createdAt", o.id AS "orgId", o.name AS "orgName", u.name FROM "OrganizationInvitation" i JOIN "Organization" o ON o.id=i."orgId" JOIN "User" u ON lower(u.email)=lower(i.email) WHERE u.password IS NULL OR i."acceptedAt" IS NOT NULL ORDER BY i."createdAt" DESC`,
  );
  const now = new Date();
  return result.rows.map((row) => {
    const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : now;
    return {
      id: typeof row.id === "string" ? row.id : "",
      name: typeof row.name === "string" ? row.name : null,
      email: typeof row.email === "string" ? row.email : "",
      workspaceId: typeof row.orgId === "string" ? row.orgId : "",
      workspaceName: typeof row.orgName === "string" ? row.orgName : "",
      role: typeof row.role === "string" ? row.role : "",
      status: row.acceptedAt
        ? "active"
        : row.revokedAt
          ? "revoked"
          : expiresAt <= now
            ? "expired"
            : "pending",
      expiresAt,
      createdAt: row.createdAt instanceof Date ? row.createdAt : now,
    };
  });
}
export async function provisionLaunchUser(
  core: CoreContext,
  request: LaunchUserRequest,
) {
  const name = request.name.trim(),
    email = request.email.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()),
    workspaceName = request.workspaceName.trim();
  if (!name || !workspaceName || !email.includes("@"))
    throw new ApiError(
      400,
      "bad_request",
      "Name, valid email, and workspace name are required",
    );
  if (
    (
      await core.pool.query(
        'SELECT EXISTS(SELECT 1 FROM "User" WHERE lower(email)=lower($1)) AS exists',
        [email],
      )
    ).rows[0].exists
  )
    throw new ApiError(
      409,
      "conflict",
      "A KasiTek account or launch invitation already exists for this email",
    );
  const userId = createId();
  await core.pool.query(
    'INSERT INTO "User"(id,name,email,"createdAt","updatedAt")VALUES($1,$2,$3,NOW(),NOW())',
    [userId, name, email],
  );
  const slug = await orgs.uniqueSlug(core.pool, orgs.slugify(workspaceName)),
    trial = trialSettings(core),
    workspace = await orgs.createOrg(
      core,
      userId,
      workspaceName,
      slug,
      null,
      trial.credits,
      trial.days,
    );
  const invitation = await orgs.createInvitation(
    core,
    workspace.id,
    workspace.name,
    userId,
    name,
    email,
    "ADMIN",
  );
  return {
    workspace,
    invitation: { id: invitation.id, email, expiresAt: invitation.expiresAt },
  };
}
export async function resendLaunchAccess(core: CoreContext, id: string) {
  const row = (
    await core.pool.query(
      `SELECT i.email,i."orgId",o.name AS "orgName",o."ownerId",u.name AS "ownerName" FROM "OrganizationInvitation" i JOIN "Organization" o ON o.id=i."orgId" JOIN "User" u ON u.id=o."ownerId" WHERE i.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw notFound();
  const invitation = await orgs.createInvitation(
    core,
    row.orgId ?? "",
    row.orgName ?? "",
    row.ownerId ?? "",
    row.ownerName ?? null,
    row.email ?? "",
    "ADMIN",
  );
  return { invitation: { id: invitation.id, expiresAt: invitation.expiresAt } };
}
export async function revokeLaunchAccess(core: CoreContext, id: string) {
  const row = (
    await core.pool.query(
      'SELECT "orgId" FROM "OrganizationInvitation" WHERE id=$1',
      [id],
    )
  ).rows[0];
  if (!row) throw notFound();
  await orgs.revokeInvitation(core.pool, row.orgId, id);
  return { revoked: true };
}
