import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type AdminCapability = "admin:read" | "admin:write" | "admin:operate" | "admin:export" | "admin:report" | "admin:support" | "admin:security" | "admin:emergency";
export interface AdminActor { id: string; role: string }
export const ADMIN_AUTHORITY_HEADER = "x-kasitek-admin-authority";
export function adminCapabilities(role: string): Set<AdminCapability> {
  const read: AdminCapability[] = ["admin:read", "admin:report"];
  switch (role.trim().toLowerCase()) {
    case "viewer": return new Set(read);
    case "support": return new Set([...read, "admin:support"]);
    case "security": return new Set([...read, "admin:security"]);
    case "operator": case "admin": return new Set([...read, "admin:write", "admin:operate", "admin:export"]);
    case "superadmin": case "owner": return new Set([...read, "admin:write", "admin:operate", "admin:export", "admin:support", "admin:security", "admin:emergency"]);
    default: return new Set();
  }
}
export function requiredAdminCapability(method: string, target: string): AdminCapability {
  const path = target.split("?")[0]!;
  if (/^\/api\/admin\/customers(?:\/|$)/.test(path)) return ["GET", "HEAD"].includes(method.toUpperCase()) ? "admin:read" : "admin:operate";
  if (/\/(?:export|exports)(?:\/|$)|\.csv$/.test(path)) return "admin:export";
  if (path === "/api/admin/password" || path.endsWith("/admin/password")) return "admin:read";
  if (path.includes("/reporting")) return "admin:report";
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return "admin:read";
  if (/\/(?:api-keys|staff|access|security)(?:\/|$)/.test(path)) return "admin:security";
  if (/\/(?:operations|operator)(?:\/|$)/.test(path)) return "admin:operate";
  return "admin:write";
}
interface AuthorityRequest { secret: string; audience: string; method: string; path: string; body?: string; now?: number }
export interface AdminAuthority extends AdminActor { issuer: "kasitek-admin"; audience: string; capability: AdminCapability; method: string; path: string; digest: string; issuedAt: number; expiresAt: number; nonce: string }
const digest = (body = "") => createHash("sha256").update(body).digest("hex");
function key(secret: string) { if (Buffer.byteLength(secret) < 32) throw new Error("KASITEK_ADMIN_SERVICE_SECRET requires at least 32 bytes"); return secret; }
export function createAdminAuthority(input: AuthorityRequest & { actor: AdminActor; capability?: AdminCapability }): string {
  const now = input.now ?? Date.now();
  const capability = input.capability ?? requiredAdminCapability(input.method, input.path);
  if (!adminCapabilities(input.actor.role).has(capability)) throw new Error("Insufficient admin capability");
  const claims: AdminAuthority = { ...input.actor, issuer: "kasitek-admin", audience: input.audience, capability, method: input.method.toUpperCase(), path: input.path, digest: digest(input.body), issuedAt: now, expiresAt: now + 60_000, nonce: randomUUID() };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", key(input.secret)).update(payload).digest("base64url")}`;
}
export function verifyAdminAuthority(token: string, input: AuthorityRequest & { capability?: AdminCapability }): AdminAuthority {
  if (token.length > 8192) throw new Error("Invalid admin authority");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("Invalid admin authority");
  const expected = createHmac("sha256", key(input.secret)).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid admin authority");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AdminAuthority;
  const now = input.now ?? Date.now();
  const capability = input.capability ?? requiredAdminCapability(input.method, input.path);
  if (claims.issuer !== "kasitek-admin" || claims.audience !== input.audience || typeof claims.id !== "string" || !claims.id || typeof claims.role !== "string" || typeof claims.nonce !== "string" || !Number.isFinite(claims.issuedAt) || !Number.isFinite(claims.expiresAt) || claims.issuedAt > now + 5000 || claims.expiresAt <= now || claims.expiresAt - claims.issuedAt > 60_000 || claims.method !== input.method.toUpperCase() || claims.path !== input.path || claims.digest !== digest(input.body) || claims.capability !== capability || !adminCapabilities(claims.role).has(capability)) throw new Error("Invalid admin authority");
  return claims;
}
