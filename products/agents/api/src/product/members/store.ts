import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { assertAgentsBillingLimit } from "../billing/billing";
import {
  canGrantRole,
  canManageRole,
  effectivePermissions,
  effectivePermissionsFor,
  grantableRoles,
  isWorkspacePermission,
  memberRoles,
  membershipRole,
  ownerOnlyPermissions,
  permissionOverrides,
  requirePermission,
  requireWorkspaceMember,
  roleCan,
  type MemberRole,
  type PermissionEffect,
  type PermissionOverride,
  type WorkspacePermission,
} from "./permissions";

export type { MemberRole } from "./permissions";
export type MemberScope = { accountId: string; organizationId: string };

export type MemberRecord = {
  accountId: string;
  displayName: string;
  email: string;
  role: MemberRole;
  joinedAt: string;
  permissions: WorkspacePermission[];
  overrides: PermissionOverride[];
};

export type InvitationRecord = {
  id: string;
  email: string;
  role: MemberRole;
  invitedByName: string;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
};

export type InvitationPreview = {
  organizationName: string;
  email: string;
  role: MemberRole;
  expiresAt: string;
  state: "pending" | "accepted" | "revoked" | "expired";
};

const role = z.enum(memberRoles);
const email = z.email().max(254);
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const normalizeEmail = (value: string) => email.parse(value.trim().toLowerCase());
const maskEmail = (value: string) => {
  const [local, domain] = value.split("@");
  return `${local?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
};
const denied = () => new PlatformError("ACCESS_DENIED", 403, "Workspace access is unavailable");
const escalationDenied = () => new PlatformError("ROLE_ESCALATION_DENIED", 403, "Your role cannot grant that role");
const notFound = () => new PlatformError("NOT_FOUND", 404, "Member not found");
const lastOwner = () => new PlatformError("LAST_OWNER", 409, "A workspace must keep at least one owner");

async function activeSeats(db: Pool | PoolClient, organizationId: string): Promise<number> {
  const result = await db.query<{ used: string }>(
    `SELECT count(*)::text AS used FROM agents_platform.memberships
     WHERE organization_id=$1 AND revoked_at IS NULL`,
    [organizationId],
  );
  return Number(result.rows[0]?.used ?? "0");
}

const activeRole = membershipRole;

async function requireMemberPermission(
  db: Pool | PoolClient,
  scope: MemberScope,
  permission: WorkspacePermission,
  lock = false,
): Promise<MemberRole> {
  return requirePermission(db, scope, permission, lock);
}

async function member(
  db: Pool | PoolClient,
  organizationId: string,
  accountId: string,
): Promise<MemberRecord> {
  const row = (await db.query<{
    account_id: string;
    display_name: string;
    email: string;
    role: MemberRole;
    created_at: Date;
  }>(
    `SELECT m.account_id,a.display_name,a.email,m.role,m.created_at
     FROM agents_platform.memberships m
     JOIN agents_platform.accounts a ON a.id=m.account_id
     WHERE m.organization_id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL`,
    [organizationId, accountId],
  )).rows[0];
  if (!row) throw notFound();
  const overrides = await permissionOverrides(db, organizationId, accountId);
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    joinedAt: iso(row.created_at),
    permissions: effectivePermissionsFor(row.role, overrides),
    overrides,
  };
}

async function accountForEmail(
  db: Pool | PoolClient,
  inviterId: string,
  value: string,
): Promise<{ id: string; display_name: string; email: string } | null> {
  const result = await db.query<{ id: string; display_name: string; email: string }>(
    `SELECT a.id,a.display_name,a.email FROM agents_platform.accounts a
     WHERE lower(a.email)=lower($1)
       AND a.issuer=(SELECT issuer FROM agents_platform.accounts WHERE id=$2)
     ORDER BY a.created_at,a.id LIMIT 1`,
    [value, inviterId],
  );
  return result.rows[0] ?? null;
}

async function invitationRecord(
  db: Pool | PoolClient,
  organizationId: string,
  invitationId: string,
): Promise<InvitationRecord> {
  const row = (await db.query<{
    id: string;
    email: string;
    role: MemberRole;
    invited_by_name: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT i.id,i.email,i.role,a.display_name invited_by_name,i.expires_at,i.created_at
     FROM agents_platform.organization_invitations i
     JOIN agents_platform.accounts a ON a.id=i.invited_by
     WHERE i.organization_id=$1 AND i.id=$2`,
    [organizationId, invitationId],
  )).rows[0];
  if (!row) throw new PlatformError("INVITATION_NOT_FOUND", 404, "Invitation not found");
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedByName: row.invited_by_name,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    expired: row.expires_at.getTime() <= Date.now(),
  };
}

export class MemberStore {
  constructor(readonly pool: Pool) {}

  async list(scope: MemberScope): Promise<{
    members: MemberRecord[];
    role: MemberRole;
    permissions: WorkspacePermission[];
    grantableRoles: MemberRole[];
  }> {
    const current = await activeRole(this.pool, scope.organizationId, scope.accountId);
    if (!current) throw denied();
    const result = await this.pool.query<{
      account_id: string;
      display_name: string;
      email: string;
      role: MemberRole;
      created_at: Date;
    }>(
      `SELECT m.account_id,a.display_name,a.email,m.role,m.created_at
       FROM agents_platform.memberships m
       JOIN agents_platform.accounts a ON a.id=m.account_id
       WHERE m.organization_id=$1 AND m.revoked_at IS NULL
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, lower(a.display_name), m.account_id`,
      [scope.organizationId],
    );
    const overrideRows = (await this.pool.query<{
      account_id: string;
      permission: WorkspacePermission;
      effect: PermissionEffect;
    }>(
      `SELECT account_id,permission,effect FROM agents_platform.member_permission_overrides
       WHERE organization_id=$1`,
      [scope.organizationId],
    )).rows;
    const overridesByAccount = new Map<string, PermissionOverride[]>();
    for (const row of overrideRows) {
      const list = overridesByAccount.get(row.account_id) ?? [];
      list.push({ permission: row.permission, effect: row.effect });
      overridesByAccount.set(row.account_id, list);
    }
    return {
      role: current,
      permissions: effectivePermissionsFor(current, overridesByAccount.get(scope.accountId) ?? []),
      grantableRoles: grantableRoles(current),
      members: result.rows.map((row) => {
        const overrides = overridesByAccount.get(row.account_id) ?? [];
        return {
          accountId: row.account_id,
          displayName: row.display_name,
          email: row.email,
          role: row.role,
          joinedAt: iso(row.created_at),
          permissions: effectivePermissionsFor(row.role, overrides),
          overrides,
        };
      }),
    };
  }

  async invitations(scope: MemberScope): Promise<InvitationRecord[]> {
    await requireMemberPermission(this.pool, scope, "members.invite");
    const result = await this.pool.query<{
      id: string;
      email: string;
      role: MemberRole;
      invited_by_name: string;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT i.id,i.email,i.role,a.display_name invited_by_name,i.expires_at,i.created_at
       FROM agents_platform.organization_invitations i
       JOIN agents_platform.accounts a ON a.id=i.invited_by
       WHERE i.organization_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       ORDER BY i.created_at DESC,i.id DESC`,
      [scope.organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      invitedByName: row.invited_by_name,
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      expired: row.expires_at.getTime() <= Date.now(),
    }));
  }

  async permissions(scope: MemberScope, accountId: string): Promise<{
    role: MemberRole;
    permissions: WorkspacePermission[];
    overrides: PermissionOverride[];
  }> {
    z.uuid().parse(accountId);
    await requireMemberPermission(this.pool, scope, "permissions.manage");
    const target = await activeRole(this.pool, scope.organizationId, accountId);
    if (!target) throw notFound();
    return (await effectivePermissions(this.pool, scope.organizationId, accountId))!;
  }

  async setPermission(
    scope: MemberScope,
    accountId: string,
    permission: string,
    effect: PermissionEffect | "inherit",
  ): Promise<{ role: MemberRole; permissions: WorkspacePermission[]; overrides: PermissionOverride[] }> {
    z.uuid().parse(accountId);
    if (!isWorkspacePermission(permission)) {
      throw new PlatformError("INVALID_PERMISSION", 400, "Unknown workspace permission");
    }
    z.enum(["grant", "deny", "inherit"]).parse(effect);
    if (accountId === scope.accountId) {
      throw new PlatformError("SELF_PERMISSION_CHANGE", 409, "You cannot change your own permissions");
    }
    return transaction(this.pool, async (db) => {
      const actorRole = await requireMemberPermission(db, scope, "permissions.manage", true);
      const targetRole = await activeRole(db, scope.organizationId, accountId, true);
      if (!targetRole) throw notFound();
      if (targetRole === "owner") {
        throw new PlatformError("OWNER_PERMISSION_IMMUTABLE", 409, "An owner always holds every permission");
      }
      if (effect === "grant") {
        if (ownerOnlyPermissions.has(permission)) {
          throw new PlatformError("PERMISSION_NOT_GRANTABLE", 409, "That permission is reserved for owners");
        }
        if (!roleCan(actorRole, permission)) throw escalationDenied();
      }
      if (effect === "inherit") {
        await db.query(
          `DELETE FROM agents_platform.member_permission_overrides
           WHERE organization_id=$1 AND account_id=$2 AND permission=$3`,
          [scope.organizationId, accountId, permission],
        );
      } else {
        await db.query(
          `INSERT INTO agents_platform.member_permission_overrides(
             organization_id,account_id,permission,effect,created_by)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (organization_id,account_id,permission) DO UPDATE
             SET effect=excluded.effect,updated_at=now()`,
          [scope.organizationId, accountId, permission, effect, scope.accountId],
        );
      }
      return {
        role: targetRole,
        permissions: effectivePermissionsFor(targetRole, await permissionOverrides(db, scope.organizationId, accountId)),
        overrides: await permissionOverrides(db, scope.organizationId, accountId),
      };
    });
  }

  async addExisting(scope: MemberScope, input: { email: string; role: MemberRole }): Promise<MemberRecord> {
    const normalized = normalizeEmail(input.email);
    const nextRole = role.parse(input.role);
    return transaction(this.pool, async (db) => {
      const actorRole = await requireMemberPermission(db, scope, "members.manage", true);
      if (!canGrantRole(actorRole, nextRole)) throw escalationDenied();
      const target = await accountForEmail(db, scope.accountId, normalized);
      if (!target) {
        throw new PlatformError(
          "ACCOUNT_NOT_FOUND",
          404,
          "No account exists for that email. Send an invitation instead.",
        );
      }
      const existing = (await db.query<{ role: MemberRole; revoked_at: Date | null }>(
        `SELECT role,revoked_at FROM agents_platform.memberships
         WHERE organization_id=$1 AND account_id=$2 FOR UPDATE`,
        [scope.organizationId, target.id],
      )).rows[0];
      if (existing && existing.revoked_at === null) {
        throw new PlatformError("ALREADY_MEMBER", 409, "That account is already a member");
      }
      if (existing && !canManageRole(actorRole, existing.role)) throw escalationDenied();
      await assertAgentsBillingLimit(
        this.pool,
        scope.organizationId,
        "limit.agent_seats",
        await activeSeats(db, scope.organizationId),
      );
      if (existing) {
        await db.query(
          `UPDATE agents_platform.memberships
           SET role=$3,revoked_at=NULL,created_at=now(),role_changed_at=now(),role_changed_by=$4
           WHERE organization_id=$1 AND account_id=$2`,
          [scope.organizationId, target.id, nextRole, scope.accountId],
        );
      } else {
        await db.query(
          `INSERT INTO agents_platform.memberships(organization_id,account_id,role)
           VALUES($1,$2,$3)`,
          [scope.organizationId, target.id, nextRole],
        );
      }
      return member(db, scope.organizationId, target.id);
    });
  }

  async invite(
    scope: MemberScope,
    input: { email: string; role: MemberRole },
  ): Promise<{ invitation: InvitationRecord; token: string; organizationName: string }> {
    const normalized = normalizeEmail(input.email);
    const nextRole = role.parse(input.role);
    return transaction(this.pool, async (db) => {
      const actorRole = await requireMemberPermission(db, scope, "members.invite", true);
      if (!canGrantRole(actorRole, nextRole)) throw escalationDenied();
      const existingMember = await accountForEmail(db, scope.accountId, normalized);
      if (existingMember && await activeRole(db, scope.organizationId, existingMember.id, true)) {
        throw new PlatformError("ALREADY_MEMBER", 409, "That account is already a member");
      }
      await db.query(
        `UPDATE agents_platform.organization_invitations
         SET revoked_at=now(),updated_at=now()
         WHERE organization_id=$1 AND lower(email)=lower($2)
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=now()`,
        [scope.organizationId, normalized],
      );
      const pending = (await db.query<{ id: string }>(
        `SELECT id FROM agents_platform.organization_invitations
         WHERE organization_id=$1 AND lower(email)=lower($2)
           AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1`,
        [scope.organizationId, normalized],
      )).rows[0];
      if (pending) {
        throw new PlatformError("INVITATION_EXISTS", 409, "An invitation is already pending for that email");
      }
      const seats = (await db.query<{ used: string }>(
        `SELECT (
           (SELECT count(*) FROM agents_platform.memberships
             WHERE organization_id=$1 AND revoked_at IS NULL) +
           (SELECT count(*) FROM agents_platform.organization_invitations
             WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
               AND expires_at>now() AND lower(email)<>lower($2))
         )::text AS used`,
        [scope.organizationId, normalized],
      )).rows[0]?.used ?? "0";
      await assertAgentsBillingLimit(
        this.pool,
        scope.organizationId,
        "limit.agent_seats",
        Number(seats),
      );
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      await db.query(
        `INSERT INTO agents_platform.organization_invitations(
           id,organization_id,email,role,token_hash,invited_by,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days')`,
        [id, scope.organizationId, normalized, nextRole, digest(token), scope.accountId],
      );
      const organization = (await db.query<{ name: string }>(
        "SELECT name FROM agents_platform.organizations WHERE id=$1",
        [scope.organizationId],
      )).rows[0];
      if (!organization) throw notFound();
      return {
        invitation: await invitationRecord(db, scope.organizationId, id),
        token,
        organizationName: organization.name,
      };
    });
  }

  async revokeInvitation(scope: MemberScope, invitationId: string): Promise<void> {
    z.uuid().parse(invitationId);
    await transaction(this.pool, async (db) => {
      const actorRole = await requireMemberPermission(db, scope, "members.invite", true);
      const pending = (await db.query<{ role: MemberRole }>(
        `SELECT role FROM agents_platform.organization_invitations
         WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [invitationId, scope.organizationId],
      )).rows[0];
      if (!pending) {
        throw new PlatformError("INVITATION_NOT_FOUND", 404, "Pending invitation not found");
      }
      if (!canGrantRole(actorRole, pending.role)) throw escalationDenied();
      const result = await db.query(
        `UPDATE agents_platform.organization_invitations
         SET revoked_at=now(),updated_at=now()
         WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [invitationId, scope.organizationId],
      );
      if (!result.rowCount) {
        throw new PlatformError("INVITATION_NOT_FOUND", 404, "Pending invitation not found");
      }
    });
  }

  async preview(token: string): Promise<InvitationPreview> {
    if (!tokenPattern.test(token)) {
      throw new PlatformError("INVITATION_NOT_FOUND", 404, "Invitation not found");
    }
    const row = (await this.pool.query<{
      email: string;
      role: MemberRole;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      organization_name: string;
    }>(
      `SELECT i.email,i.role,i.expires_at,i.accepted_at,i.revoked_at,o.name organization_name
       FROM agents_platform.organization_invitations i
       JOIN agents_platform.organizations o ON o.id=i.organization_id
       WHERE i.token_hash=$1`,
      [digest(token)],
    )).rows[0];
    if (!row) throw new PlatformError("INVITATION_NOT_FOUND", 404, "Invitation not found");
    return {
      organizationName: row.organization_name,
      email: maskEmail(row.email),
      role: row.role,
      expiresAt: iso(row.expires_at),
      state: row.accepted_at
        ? "accepted"
        : row.revoked_at
          ? "revoked"
          : row.expires_at.getTime() <= Date.now()
            ? "expired"
            : "pending",
    };
  }

  async accept(
    accountId: string,
    token: string,
  ): Promise<{ organization: { id: string; name: string; role: MemberRole } }> {
    if (!tokenPattern.test(token)) {
      throw new PlatformError("INVITATION_NOT_FOUND", 404, "Invitation not found");
    }
    return transaction(this.pool, async (db) => {
      const invitation = (await db.query<{
        id: string;
        organization_id: string;
        email: string;
        role: MemberRole;
        accepted_at: Date | null;
        accepted_by: string | null;
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id,organization_id,email,role,accepted_at,accepted_by,revoked_at,expires_at
         FROM agents_platform.organization_invitations
         WHERE token_hash=$1 FOR UPDATE`,
        [digest(token)],
      )).rows[0];
      if (!invitation) throw new PlatformError("INVITATION_NOT_FOUND", 404, "Invitation not found");
      const account = (await db.query<{ email: string }>(
        "SELECT email FROM agents_platform.accounts WHERE id=$1",
        [accountId],
      )).rows[0];
      if (!account) throw denied();
      if (invitation.accepted_at) {
        if (invitation.accepted_by !== accountId) {
          throw new PlatformError("INVITATION_ALREADY_ACCEPTED", 409, "This invitation was already accepted");
        }
        const existing = await activeRole(db, invitation.organization_id, accountId);
        if (!existing) throw new PlatformError("INVITATION_ALREADY_ACCEPTED", 409, "This invitation was already accepted");
        const org = (await db.query<{ id: string; name: string }>(
          "SELECT id,name FROM agents_platform.organizations WHERE id=$1",
          [invitation.organization_id],
        )).rows[0]!;
        return { organization: { ...org, role: existing } };
      }
      if (invitation.revoked_at) {
        throw new PlatformError("INVITATION_REVOKED", 410, "This invitation was revoked");
      }
      if (invitation.expires_at.getTime() <= Date.now()) {
        throw new PlatformError("INVITATION_EXPIRED", 410, "This invitation has expired");
      }
      if (invitation.email.toLowerCase() !== account.email.toLowerCase()) {
        throw new PlatformError(
          "INVITATION_EMAIL_MISMATCH",
          403,
          "Sign in with the email address that received this invitation",
        );
      }
      const existing = (await db.query<{ role: MemberRole; revoked_at: Date | null }>(
        `SELECT role,revoked_at FROM agents_platform.memberships
         WHERE organization_id=$1 AND account_id=$2 FOR UPDATE`,
        [invitation.organization_id, accountId],
      )).rows[0];
      let acceptedRole: MemberRole;
      if (existing && existing.revoked_at === null) {
        acceptedRole = existing.role;
      } else {
        acceptedRole = invitation.role;
        const seats = (await db.query<{ used: string }>(
          `SELECT (
             (SELECT count(*) FROM agents_platform.memberships
               WHERE organization_id=$1 AND revoked_at IS NULL) +
             (SELECT count(*) FROM agents_platform.organization_invitations
               WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
                 AND expires_at>now() AND id<>$2)
           )::text AS used`,
          [invitation.organization_id, invitation.id],
        )).rows[0]?.used ?? "0";
        await assertAgentsBillingLimit(
          this.pool,
          invitation.organization_id,
          "limit.agent_seats",
          Number(seats),
        );
        if (existing) {
          await db.query(
            `UPDATE agents_platform.memberships
             SET role=$3,revoked_at=NULL,created_at=now()
             WHERE organization_id=$1 AND account_id=$2`,
            [invitation.organization_id, accountId, acceptedRole],
          );
        } else {
          await db.query(
            `INSERT INTO agents_platform.memberships(organization_id,account_id,role)
             VALUES($1,$2,$3)`,
            [invitation.organization_id, accountId, acceptedRole],
          );
        }
      }
      await db.query(
        `UPDATE agents_platform.organization_invitations
         SET accepted_at=now(),accepted_by=$2,updated_at=now()
         WHERE id=$1`,
        [invitation.id, accountId],
      );
      const org = (await db.query<{ id: string; name: string }>(
        "SELECT id,name FROM agents_platform.organizations WHERE id=$1",
        [invitation.organization_id],
      )).rows[0]!;
      return { organization: { ...org, role: acceptedRole } };
    });
  }

  async changeRole(scope: MemberScope, accountId: string, nextRole: MemberRole): Promise<MemberRecord> {
    z.uuid().parse(accountId);
    const roleValue = role.parse(nextRole);
    if (accountId === scope.accountId) {
      throw new PlatformError("SELF_ROLE_CHANGE", 409, "You cannot change your own role");
    }
    return transaction(this.pool, async (db) => {
      const actorRole = await requireMemberPermission(db, scope, "members.manage", true);
      const target = (await db.query<{ role: MemberRole }>(
        `SELECT role FROM agents_platform.memberships
         WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR UPDATE`,
        [scope.organizationId, accountId],
      )).rows[0];
      if (!target) throw notFound();
      if (!canManageRole(actorRole, target.role)) throw escalationDenied();
      if (!canGrantRole(actorRole, roleValue)) throw escalationDenied();
      if (target.role === "owner" && roleValue !== "owner") {
        const owners = await db.query<{ count: string }>(
          `SELECT count(*)::text count FROM agents_platform.memberships
           WHERE organization_id=$1 AND role='owner' AND revoked_at IS NULL`,
          [scope.organizationId],
        );
        if (Number(owners.rows[0]?.count ?? 0) <= 1) throw lastOwner();
      }
      await db.query(
        `UPDATE agents_platform.memberships
         SET role=$3,role_changed_at=now(),role_changed_by=$4
         WHERE organization_id=$1 AND account_id=$2`,
        [scope.organizationId, accountId, roleValue, scope.accountId],
      );
      return member(db, scope.organizationId, accountId);
    });
  }

  async remove(scope: MemberScope, accountId: string): Promise<void> {
    z.uuid().parse(accountId);
    await transaction(this.pool, async (db) => {
      const actorRole = await requireWorkspaceMember(db, scope, true);
      const target = (await db.query<{ role: MemberRole }>(
        `SELECT role FROM agents_platform.memberships
         WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR UPDATE`,
        [scope.organizationId, accountId],
      )).rows[0];
      if (!target) throw notFound();
      // Leaving a workspace is always available to the member themselves.
      if (accountId !== scope.accountId) {
        if (!roleCan(actorRole, "members.manage")) {
          throw new PlatformError("INSUFFICIENT_ROLE", 403, "Your role does not allow this action");
        }
        if (!canManageRole(actorRole, target.role)) throw escalationDenied();
      }
      if (target.role === "owner") {
        const owners = await db.query<{ count: string }>(
          `SELECT count(*)::text count FROM agents_platform.memberships
           WHERE organization_id=$1 AND role='owner' AND revoked_at IS NULL`,
          [scope.organizationId],
        );
        if (Number(owners.rows[0]?.count ?? 0) <= 1) throw lastOwner();
      }
      await db.query(
        `UPDATE agents_platform.memberships SET revoked_at=now()
         WHERE organization_id=$1 AND account_id=$2`,
        [scope.organizationId, accountId],
      );
      await db.query(
        `DELETE FROM agents_platform.member_permission_overrides
         WHERE organization_id=$1 AND account_id=$2`,
        [scope.organizationId, accountId],
      );
    });
  }
}
