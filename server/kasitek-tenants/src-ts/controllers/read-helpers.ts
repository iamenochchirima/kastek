import type { FastifyRequest } from "fastify";
import type { TenantContext } from "../context.js";
import { extractAccessContext, requireTenantRoles } from "../middleware.js";
import { wireInteger, integer } from "@kasitek/server-support/json";
export const WORKSPACE_READ_ROLES = [
  "owner",
  "admin",
  "account_manager",
  "viewer",
  "support",
  "sales_manager",
  "content_manager",
  "automation_manager",
] as const;
export const CONVERSATION_ROLES = [
  "owner",
  "admin",
  "account_manager",
  "support",
  "sales_manager",
] as const;
export const AGENT_ROLES = [
  "owner",
  "admin",
  "automation_manager",
  "support",
] as const;
export const USAGE_ROLES = [
  "owner",
  "admin",
  "account_manager",
  "viewer",
] as const;
export async function access(
  request: FastifyRequest,
  context: TenantContext,
  roles: readonly string[],
) {
  const session = await extractAccessContext(request, context);
  if (session.tenant_user_id !== null)
    requireTenantRoles(session.tenant_user_roles, roles);
  return session;
}
export const count = (value: unknown) =>
  wireInteger(integer((value ?? 0) as string | number | bigint));
export const id = (request: FastifyRequest) =>
  (request.params as { id: string }).id;
