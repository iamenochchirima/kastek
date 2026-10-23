import { adminCapabilities, requiredAdminCapability } from "@kasitek-labs/server-support/admin-authority";
export const ADMIN_API_PREFIXES = ["/api/activity", "/api/agencies", "/api/analytics", "/api/billing", "/api/conversations", "/api/core/admin", "/api/invoices", "/api/leads", "/api/notifications", "/api/operations", "/api/outreach", "/api/quotations", "/api/reports", "/api/web-services"];
export const PUBLIC_ADMIN_API_PATHS = new Set(["/api/core/admin/login", "/api/core/admin/logout", "/api/core/admin/forgot-password", "/api/core/admin/reset-password"]);
export function validAdminMutationOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const expected = new URL(process.env.ADMIN_FRONTEND_URL ?? request.url).origin;
  return request.headers.get("origin") === expected && request.headers.get("sec-fetch-site") !== "cross-site";
}
export function authorizedAdminRequest(role: string, method: string, path: string): boolean {
  return adminCapabilities(role).has(requiredAdminCapability(method, path));
}
