import { createAdminAuthority, adminCapabilities, requiredAdminCapability, ADMIN_AUTHORITY_HEADER } from "@kasitek-labs/server-support/admin-authority";
import type { AdminUser } from "./admin-auth";

export function adminServiceHeaders(actor: AdminUser, audience: string, method: string, path: string, body = ""): Record<string, string> {
  const secret = process.env.KASITEK_ADMIN_SERVICE_SECRET;
  if (!secret) throw new Error("KASITEK_ADMIN_SERVICE_SECRET is not configured");
  if (!adminCapabilities(actor.role).has(requiredAdminCapability(method, path))) throw new Error("Insufficient admin capability");
  return { [ADMIN_AUTHORITY_HEADER]: createAdminAuthority({secret, audience, actor, method, path, body}) };
}
