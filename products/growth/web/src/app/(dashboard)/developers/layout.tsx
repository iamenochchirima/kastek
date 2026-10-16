import { DevelopersPortalShell } from "@/components/dashboard/developers/developers-portal-shell";
import { fetchCoreJson } from "@/lib/core-server-api";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fallbackDevelopersConfig, type DevelopersBootstrap } from "@/lib/developers";
import { redirect } from "next/navigation";

export default async function DevelopersLayout({ children }: { children: React.ReactNode }) {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");

  const bootstrap = await fetchCoreJson<DevelopersBootstrap>("/api/developers").catch(() => ({
    apiKeys: [],
    config: fallbackDevelopersConfig,
  }));

  return <DevelopersPortalShell initial={bootstrap}>{children}</DevelopersPortalShell>;
}
