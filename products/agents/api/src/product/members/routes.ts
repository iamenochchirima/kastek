import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import type { Account } from "../../contracts/records";
import { MemberStore, type InvitationRecord, type MemberRole, type MemberScope } from "./store";
import { memberRoles } from "../../platform/access";

const role = z.enum(memberRoles);
const memberBody = z.strictObject({ email: z.email().max(254), role: role.default("member") });
const invitationBody = z.strictObject({ email: z.email().max(254), role: role.default("member") });
const roleBody = z.strictObject({ role });
const permissionBody = z.strictObject({ effect: z.enum(["grant", "deny", "inherit"]) });
const invitationId = z.uuid();
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export type InvitationSender = (input: {
  invitation: InvitationRecord;
  token: string;
  organizationName: string;
}) => Promise<void>;

export function registerMemberRoutes(
  app: FastifyInstance,
  options: {
    store: MemberStore;
    resolveScope(request: FastifyRequest): Promise<MemberScope>;
    account(request: FastifyRequest): Promise<Account>;
    sendInvitation: InvitationSender;
  },
) {
  const base = "/api/organizations/:organizationId";
  const params = (request: FastifyRequest) => request.params as Record<string, string>;

  app.get(`${base}/members`, async (request) => {
    const result = await options.store.list(await options.resolveScope(request));
    return {
      members: result.members,
      role: result.role,
      canManage: result.permissions.includes("members.manage"),
      permissions: result.permissions,
      grantableRoles: result.grantableRoles,
    };
  });

  app.get(`${base}/members/:accountId/permissions`, async (request) => {
    const scope = await options.resolveScope(request);
    const accountId = z.uuid().parse(params(request).accountId);
    return { member: await options.store.permissions(scope, accountId) };
  });

  app.put(`${base}/members/:accountId/permissions/:permission`, async (request) => {
    const scope = await options.resolveScope(request);
    const accountId = z.uuid().parse(params(request).accountId);
    const permission = z.string().min(3).max(64).parse(params(request).permission);
    const input = permissionBody.parse(request.body ?? {});
    const member = await options.store.setPermission(scope, accountId, permission, input.effect);
    request.log.info(
      {
        event: "members.permission_changed",
        organizationId: scope.organizationId,
        accountId,
        permission,
        effect: input.effect,
      },
      "Workspace member permission changed",
    );
    return { member };
  });

  app.post(`${base}/members`, async (request, reply) => {
    const scope = await options.resolveScope(request);
    const input = memberBody.parse(request.body ?? {});
    const member = await options.store.addExisting(scope, input);
    request.log.info(
      { event: "members.added", organizationId: scope.organizationId, accountId: member.accountId, role: member.role },
      "Workspace member added",
    );
    return reply.code(201).send({ member });
  });

  app.patch(`${base}/members/:accountId`, async (request) => {
    const scope = await options.resolveScope(request);
    const accountId = z.uuid().parse(params(request).accountId);
    const input = roleBody.parse(request.body ?? {});
    const member = await options.store.changeRole(scope, accountId, input.role as MemberRole);
    request.log.info(
      { event: "members.role_changed", organizationId: scope.organizationId, accountId, role: member.role },
      "Workspace member role changed",
    );
    return { member };
  });

  app.delete(`${base}/members/:accountId`, async (request) => {
    const scope = await options.resolveScope(request);
    const accountId = z.uuid().parse(params(request).accountId);
    await options.store.remove(scope, accountId);
    request.log.info(
      { event: "members.removed", organizationId: scope.organizationId, accountId },
      "Workspace member removed",
    );
    return { message: "Member removed" };
  });

  app.get(`${base}/invitations`, async (request) => {
    const scope = await options.resolveScope(request);
    return { invitations: await options.store.invitations(scope) };
  });

  app.post(`${base}/invitations`, async (request, reply) => {
    const scope = await options.resolveScope(request);
    const input = invitationBody.parse(request.body ?? {});
    const invited = await options.store.invite(scope, input);
    try {
      await options.sendInvitation({
        invitation: invited.invitation,
        token: invited.token,
        organizationName: invited.organizationName,
      });
    } catch (error) {
      request.log.error(
        {
          event: "members.invitation_email_failed",
          organizationId: scope.organizationId,
          invitationId: invited.invitation.id,
          code: error instanceof PlatformError ? error.code : "INVITATION_EMAIL_FAILED",
        },
        "Invitation email failed",
      );
      throw error;
    }
    request.log.info(
      {
        event: "members.invited",
        organizationId: scope.organizationId,
        invitationId: invited.invitation.id,
        role: invited.invitation.role,
      },
      "Workspace invitation created",
    );
    return reply.code(201).send({ invitation: invited.invitation });
  });

  app.delete(`${base}/invitations/:invitationId`, async (request) => {
    const scope = await options.resolveScope(request);
    const id = invitationId.parse(params(request).invitationId);
    await options.store.revokeInvitation(scope, id);
    request.log.info(
      { event: "members.invitation_revoked", organizationId: scope.organizationId, invitationId: id },
      "Workspace invitation revoked",
    );
    return { message: "Invitation revoked" };
  });

  app.get("/api/invitations/:token", async (request) => {
    const invitation = await options.store.preview(token.parse(params(request).token));
    return { invitation };
  });

  app.post("/api/invitations/:token/accept", async (request) => {
    const user = await options.account(request);
    const accepted = await options.store.accept(user.id, token.parse(params(request).token));
    request.log.info(
      {
        event: "members.invitation_accepted",
        organizationId: accepted.organization.id,
        accountId: user.id,
      },
      "Workspace invitation accepted",
    );
    return accepted;
  });
}
