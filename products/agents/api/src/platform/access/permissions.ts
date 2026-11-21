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
  | "permissions.manage"
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
  "permissions.manage",
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

const permissionSet = new Set<string>(workspacePermissions);

export function isWorkspacePermission(value: unknown): value is WorkspacePermission {
  return typeof value === "string" && permissionSet.has(value);
}

/** Owner-only capabilities: destructive workspace actions, money, credentials and access grants. */
export const ownerOnlyPermissions: ReadonlySet<WorkspacePermission> = new Set([
  "workspace.delete",
  "workspace.transfer",
  "billing.manage",
  "credentials.manage",
  "members.escalate",
  "permissions.manage",
]);

/** Usage-only capabilities granted to members. Configuration stays with owner and admin. */
const memberAllowed = new Set<WorkspacePermission>([
  "members.read",
  "agents.read",
  "knowledge.read",
  "conversations.read",
  "conversations.manage",
]);

export type PermissionEffect = "grant" | "deny";
export type PermissionOverride = { permission: WorkspacePermission; effect: PermissionEffect };

export function roleCan(role: MemberRole, permission: WorkspacePermission): boolean {
  if (role === "owner") return true;
  if (ownerOnlyPermissions.has(permission)) return false;
  if (role === "admin") return true;
  return memberAllowed.has(permission);
}

export function permissionsFor(role: MemberRole): WorkspacePermission[] {
  return workspacePermissions.filter((permission) => roleCan(role, permission));
}

/** Deny wins over grant. Owner ignores overrides entirely. */
export function effectivePermissionsFor(
  role: MemberRole,
  overrides: readonly PermissionOverride[],
): WorkspacePermission[] {
  if (role === "owner") return permissionsFor(role);
  const allowed = new Set(permissionsFor(role));
  for (const override of overrides) {
    if (override.effect === "deny") allowed.delete(override.permission);
    else if (!ownerOnlyPermissions.has(override.permission)) allowed.add(override.permission);
  }
  return workspacePermissions.filter((permission) => allowed.has(permission));
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

async function overrideFlags(
  db: Pool | PoolClient,
  organizationId: string,
  accountId: string,
  permission: WorkspacePermission,
): Promise<{ granted: boolean; denied: boolean }> {
  const row = (await db.query<{ granted: boolean; denied: boolean }>(
    `SELECT bool_or(effect='grant') AS granted, bool_or(effect='deny') AS denied
     FROM agents_platform.member_permission_overrides
     WHERE organization_id=$1 AND account_id=$2 AND permission=$3`,
    [organizationId, accountId, permission],
  )).rows[0];
  return { granted: Boolean(row?.granted), denied: Boolean(row?.denied) };
}

export async function requirePermission(
  db: Pool | PoolClient,
  scope: WorkspaceScope,
  permission: WorkspacePermission,
  lock = false,
): Promise<MemberRole> {
  const role = await requireWorkspaceMember(db, scope, lock);
  if (role === "owner") return role;
  if (ownerOnlyPermissions.has(permission)) throw permissionRequired();
  const { granted, denied } = await overrideFlags(db, scope.organizationId, scope.accountId, permission);
  if (denied || (!granted && !roleCan(role, permission))) throw permissionRequired();
  return role;
}

export async function permissionOverrides(
  db: Pool | PoolClient,
  organizationId: string,
  accountId: string,
): Promise<PermissionOverride[]> {
  const result = await db.query<{ permission: WorkspacePermission; effect: PermissionEffect }>(
    `SELECT permission,effect FROM agents_platform.member_permission_overrides
     WHERE organization_id=$1 AND account_id=$2
     ORDER BY permission`,
    [organizationId, accountId],
  );
  return result.rows.map((row) => ({ permission: row.permission, effect: row.effect }));
}

export async function effectivePermissions(
  db: Pool | PoolClient,
  organizationId: string,
  accountId: string,
): Promise<{ role: MemberRole; permissions: WorkspacePermission[]; overrides: PermissionOverride[] } | null> {
  const role = await membershipRole(db, organizationId, accountId);
  if (!role) return null;
  const overrides = await permissionOverrides(db, organizationId, accountId);
  return {
    role,
    permissions: effectivePermissionsFor(role, overrides),
    overrides,
  };
}
