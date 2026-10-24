import { redirect } from "react-router";
import { ApiError, fetchCoreJson } from "@/lib/core-server-api";
import { clearPrivateQueries, requestScope } from "@/lib/query-client";
import type { Org } from "@/lib/orgs";

export type CoreSessionUser = { id: string; name: string; email: string; image: string; emailVerified: string | null };
export type CoreSession = { user: CoreSessionUser };
export type WorkspaceContext = { session: CoreSession | null; orgs: Org[]; activeOrgId: string | null };
type Navigation = { scope: number; session?: Promise<CoreSession | null>; workspace?: Promise<WorkspaceContext> };
const navigations = new WeakMap<Request, Navigation>();
let observedUser: string | undefined;

function assertCurrent(request: Request, navigation: Navigation) {
  request.signal.throwIfAborted();
  if (navigation.scope !== requestScope()) throw new DOMException("Workspace changed during navigation", "AbortError");
}
function navigationFor(request: Request): Navigation {
  let navigation = navigations.get(request);
  if (!navigation) { navigation = { scope: requestScope() }; navigations.set(request, navigation); }
  assertCurrent(request, navigation);
  return navigation;
}
async function readNavigationJson<T>(request: Request, navigation: Navigation, path: string): Promise<T> {
  assertCurrent(request, navigation);
  // A router Request owns these authorization reads. Its abort cannot cancel a later navigation.
  const response = await fetch(path, { credentials: "include", cache: "no-store", signal: request.signal });
  assertCurrent(request, navigation);
  if (!response.ok) throw new ApiError(response.status, path);
  const value = await response.json() as T;
  assertCurrent(request, navigation);
  return value;
}
async function loadSession(request?: Request, navigation?: Navigation): Promise<CoreSession | null> {
  try {
    const payload = request && navigation
      ? await readNavigationJson<{ user?: CoreSessionUser }>(request, navigation, "/api/auth/me")
      : await fetchCoreJson<{ user?: CoreSessionUser }>("/api/auth/me");
    if (!payload.user) return null;
    if (observedUser && observedUser !== payload.user.id) {
      clearPrivateQueries();
      if (navigation) navigation.scope = requestScope();
    }
    observedUser = payload.user.id;
    return { user: { ...payload.user, name: payload.user.name ?? "", email: payload.user.email ?? "", image: payload.user.image ?? "", emailVerified: payload.user.emailVerified ?? null } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      if (request && navigation) assertCurrent(request, navigation);
      observedUser = undefined;
      clearPrivateQueries();
      // This navigation discovered logout itself and can still follow its login redirect.
      if (navigation) navigation.scope = requestScope();
      return null;
    }
    throw error;
  }
}
export function getCoreSession(request?: Request): Promise<CoreSession | null> {
  if (!request) return loadSession();
  const navigation = navigationFor(request);
  return navigation.session ??= loadSession(request, navigation);
}
export function getWorkspaceContext(request: Request): Promise<WorkspaceContext> {
  const navigation = navigationFor(request);
  return navigation.workspace ??= (async () => {
    const session = await getCoreSession(request);
    assertCurrent(request, navigation);
    if (!session) return { session: null, orgs: [], activeOrgId: null };
    const payload = await readNavigationJson<{ orgs: Org[]; activeOrgId: string | null }>(request, navigation, "/api/orgs");
    return { session, orgs: payload.orgs, activeOrgId: payload.orgs.find(org => org.id === payload.activeOrgId)?.id ?? payload.orgs[0]?.id ?? null };
  })();
}
export async function getWorkspaceSession(request?: Request): Promise<CoreSession | null> {
  const context = request ? await getWorkspaceContext(request) : { session: await getCoreSession(), orgs: null };
  if (!context.session) return null;
  const orgs = context.orgs ?? (await fetchCoreJson<{ orgs: Org[] }>("/api/orgs")).orgs;
  if (!orgs.length) throw redirect("/onboarding");
  return context.session;
}
