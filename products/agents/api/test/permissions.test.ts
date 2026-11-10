import { describe, expect, it } from "vitest";
import {
  canGrantRole,
  canManageRole,
  grantableRoles,
  memberRoles,
  permissionsFor,
  roleAtLeast,
  roleCan,
  sqlRoles,
  workspacePermissions,
} from "../src/product/members/permissions";

describe("workspace permissions", () => {
  it("gives owners every permission", () => {
    expect(permissionsFor("owner")).toEqual([...workspacePermissions]);
  });

  it("keeps destructive, billing and credential permissions with owners", () => {
    for (const permission of ["workspace.delete", "workspace.transfer", "billing.manage", "credentials.manage", "members.escalate"] as const) {
      expect(roleCan("owner", permission)).toBe(true);
      expect(roleCan("admin", permission)).toBe(false);
      expect(roleCan("member", permission)).toBe(false);
    }
  });

  it("lets admins configure the workspace but not own it", () => {
    for (const permission of ["agents.manage", "knowledge.approve", "channels.manage", "deploy.manage", "models.select", "members.invite", "members.manage"] as const) {
      expect(roleCan("admin", permission)).toBe(true);
    }
    expect(roleCan("admin", "workspace.manage")).toBe(true);
  });

  it("keeps members to read and conversation use", () => {
    expect(permissionsFor("member")).toEqual([
      "members.read",
      "agents.read",
      "knowledge.read",
      "conversations.read",
      "conversations.manage",
    ]);
    expect(roleCan("member", "agents.manage")).toBe(false);
    expect(roleCan("member", "members.invite")).toBe(false);
    expect(roleCan("member", "members.manage")).toBe(false);
    expect(roleCan("member", "conversations.assign")).toBe(false);
  });

  it("orders roles and resolves grantable roles", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(grantableRoles("owner")).toEqual([...memberRoles]);
    expect(grantableRoles("admin")).toEqual(["admin", "member"]);
    expect(grantableRoles("member")).toEqual([]);
  });

  it("blocks privilege escalation", () => {
    expect(canGrantRole("owner", "owner")).toBe(true);
    expect(canGrantRole("admin", "admin")).toBe(true);
    expect(canGrantRole("admin", "owner")).toBe(false);
    expect(canManageRole("admin", "member")).toBe(true);
    expect(canManageRole("admin", "admin")).toBe(false);
    expect(canManageRole("admin", "owner")).toBe(false);
    expect(canManageRole("member", "member")).toBe(false);
  });

  it("renders static SQL role lists", () => {
    expect(sqlRoles("agents.manage")).toBe("'owner','admin'");
    expect(sqlRoles("billing.manage")).toBe("'owner'");
  });
});
