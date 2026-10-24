import { redirect } from "react-router";
import { ApiError, fetchCoreJson } from "@/lib/core-server-api";
import { clearPrivateQueries } from "@/lib/query-client";

export type CoreSessionUser = { id: string; name: string; email: string; image: string; emailVerified: string | null };
export type CoreSession = { user: CoreSessionUser };
let observedUser: string | undefined;
export async function getCoreSession(): Promise<CoreSession | null> {
  try {
    const payload = await fetchCoreJson<{ user?: CoreSessionUser }>("/api/auth/me");
    if (!payload.user) return null;
    if (observedUser && observedUser !== payload.user.id) clearPrivateQueries();
    observedUser = payload.user.id;
    return { user: { ...payload.user, name: payload.user.name ?? "", email: payload.user.email ?? "", image: payload.user.image ?? "", emailVerified: payload.user.emailVerified ?? null } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { observedUser = undefined; clearPrivateQueries(); return null; }
    throw error;
  }
}
export async function getWorkspaceSession(): Promise<CoreSession | null> {
  const session = await getCoreSession();
  if (!session) return null;
  const payload = await fetchCoreJson<{ orgs: Array<{ id: string }> }>("/api/orgs");
  if (!payload.orgs.length) throw redirect("/onboarding");
  return session;
}
