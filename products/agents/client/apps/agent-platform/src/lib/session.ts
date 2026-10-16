import { ApiError, fetchApiJson } from "./api-client";
export type SessionUser = { id: string; name: string; email: string; image: string; emailVerified: string | null };
export type Session = { user: SessionUser; organizations?: { id: string; name: string; role?: string }[]; activeOrganizationId?: string | null };
export async function getSession(): Promise<Session | null> {
  try { return await fetchApiJson<Session>("/api/auth/me"); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
export async function createWorkspace(name: string): Promise<void> {
  await fetchApiJson("/api/auth/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
}
export async function selectWorkspace(organizationId: string): Promise<void> {
  await fetchApiJson("/api/auth/organization", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId }) });
}
export async function logout(everywhere = false): Promise<void> {
  const result = await fetchApiJson<{ redirectTo: string; providerLogoutPending?: boolean }>(`/api/auth/${everywhere ? "logout-all" : "logout"}`, { method: "POST" });
  window.location.assign(result.providerLogoutPending ? "/login?logout=local" : result.redirectTo);
}
