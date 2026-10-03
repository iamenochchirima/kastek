import { cache } from "react";
import { redirect } from "next/navigation";
import { fetchCoreJson } from "@/lib/core-server-api";

export type CoreSessionUser = {
  id: string;
  name: string;
  email: string;
  image: string;
  emailVerified: string | null;
};

export type CoreSession = {
  user: CoreSessionUser;
};

export const getCoreSession = cache(async (): Promise<CoreSession | null> => {
  try {
    const payload = await fetchCoreJson<{ user?: CoreSessionUser }>("/api/auth/me");
    if (!payload.user) {
      return null;
    }

    return {
      user: {
        id: payload.user.id,
        name: payload.user.name ?? "",
        email: payload.user.email ?? "",
        image: payload.user.image ?? "",
        emailVerified: payload.user.emailVerified ?? null,
      },
    };
  } catch {
    return null;
  }
});

// Server layouts and pages render concurrently. Each dashboard data loader must await
// this guard before accessing an organization, rather than relying on its layout alone.
export const getWorkspaceSession = cache(async (): Promise<CoreSession | null> => {
  const session = await getCoreSession();
  if (!session) return null;
  const payload = await fetchCoreJson<{ orgs: Array<{ id: string }> }>("/api/orgs");
  if (!payload.orgs.length) redirect("/onboarding");
  return session;
});
