import { ApiError, fetchApiJson } from "./api-client";
export type SessionUser = { id: string; name: string; email: string; image: string; emailVerified: string | null };
export type Session = { user: SessionUser; organizations?: { id: string; name: string }[]; activeOrganizationId?: string };
export async function getSession(): Promise<Session | null> {
  try { return await fetchApiJson<Session>("/api/auth/me"); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
