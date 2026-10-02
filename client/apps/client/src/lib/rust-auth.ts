import { cache } from "react";
import { redirect } from "next/navigation";
import { fetchRustJson } from "@/lib/rust-server-api";

export type RustSessionUser = {
  id: string;
  name: string;
  email: string;
  image: string;
  emailVerified: string | null;
};

export type RustSession = {
  user: RustSessionUser;
};

export const getRustSession = cache(async (): Promise<RustSession | null> => {
  try {
    const payload = await fetchRustJson<{ user?: RustSessionUser }>("/api/auth/me");
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
export const getWorkspaceSession = cache(async (): Promise<RustSession | null> => {
  const session = await getRustSession();
  if (!session) return null;
  const payload = await fetchRustJson<{ orgs: Array<{ id: string }> }>("/api/orgs");
  if (!payload.orgs.length) redirect("/onboarding");
  return session;
});
