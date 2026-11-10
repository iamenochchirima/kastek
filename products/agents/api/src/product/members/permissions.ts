import type { Pool, PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";

export type MemberRole = "owner" | "admin" | "member";

export const memberRoles = ["owner", "admin", "member"] as const;

export type WorkspacePermission =
  | "workspace.manage"
  | "workspace.delete"
  | "workspace.transfer"
  | "billing.manage"
  | "members.read"
  | "members.invite"
  | "members.manage"
  | "members.escalate"
  | "agents.read"
  | "agents.manage"
  | "agents.delete"
  | "knowledge.read"
  | "knowledge.manage"
  | "knowledge.approve"
  | "channels.manage"
  | "deploy.manage"
  | "models.select"
  | "credentials.manage"
  | "conversations.read"
  | "conversations.manage"
  | "conversations.assign";

export const workspacePermissions: readonly WorkspacePermission[] = [
  "workspace.manage",
  "workspace.delete",
  "workspace.transfer",
  "billing.manage",
  "members.read",
  "members.invite",
  "members.manage",
  "members.escalate",
  "agents.read",
  "agents.manage",
  "agents.delete",
  "knowledge.read",
  "knowledge.manage",
  "knowledge.approve",
  "channels.manage",
  "deploy.manage",
  "models.select",
  "credentials.manage",
  "conversations.read",
  "conversations.manage",
  "conversations.assign",
];

/** Owner-only capabilities: destructive workspace actions, money and provider credentials. */
const ownerOnly = new Set<WorkspacePermission>([
  "workspace.delete",
  "workspace.transfer",
  "billing.manage",
  "credentials.manage",
  "members.escalate",
]);

/** Usage-only capabilities granted to members. Configuration stays with owner and admin. */
const memberAllowed = new Set<WorkspacePermission>([
  "members.read",
  "agents.read",
  "knowledge.read",
  "conversations.read",
  "conversations.manage",
]);

export function roleCan(role: MemberRole, permission: WorkspacePermission): boolean {
  if (role === "owner") return true;
  if (ownerOnly.has(permission)) return false;
  if (role === "admin") return true;
  return memberAllowed.has(permission);
}

export function permissionsFor(role: MemberRole): WorkspacePermission[] {
  return workspacePermissions.filter((permission) => roleCan(role, permission));
}

export function rolesWithPermission(permission: WorkspacePermission): MemberRole[] {
  return memberRoles.filter((role) => roleCan(role, permission));
}

/** Owners grant any role. Admins grant admins and members, never owners. */
export function canGrantRole(actor: MemberRole, next: MemberRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return next !== "owner";
  return false;
}

/** Owners manage every role. Admins manage members only; peers and owners are owner-managed. */
export function canManageRole(actor: MemberRole, target: MemberRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target === "member";
  return false;
}

export function grantableRoles(actor: MemberRole): MemberRole[] {
  return memberRoles.filter((role) => canGrantRole(actor, role));
}

export type WorkspaceScope = { accountId: string; organizationId: string };

const accessDenied = () =>
  new PlatformError("ACCESS_DENIED", 403, "Workspace access is unavailable");
const permissionRequired = () =>
  new PlatformError("INSUFFICIENT_ROLE", 403, "Your role does not allow this action");

export async function membershipRole(
  db: Pool | PoolClient,
  organizationId: string,
  accountId: string,
  lock = false,
): Promise<MemberRole | null> {
  const result = await db.query<{ role: MemberRole }>(
    `SELECT role FROM agents_platform.memberships
     WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL
     ${lock ? "FOR UPDATE" : ""}`,
    [organizationId, accountId],
  );
  return result.rows[0]?.role ?? null;
}

export async function requireWorkspaceMember(
  db: Pool | PoolClient,
  scope: WorkspaceScope,
  lock = false,
): Promise<MemberRole> {
  const role = await membershipRole(db, scope.organizationId, scope.accountId, lock);
  if (!role) throw accessDenied();
  return role;
}

export async function requirePermission(
  db: Pool | PoolClient,
  scope: WorkspaceScope,
  permission: WorkspacePermission,
  lock = false,
): Promise<MemberRole> {
  const role = await requireWorkspaceMember(db, scope, lock);
  if (!roleCan(role, permission)) throw permissionRequired();
  return role;
}

