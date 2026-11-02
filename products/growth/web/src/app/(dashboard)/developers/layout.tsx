import { useLoaderData } from "react-router";
import { Outlet } from "react-router";
import { DevelopersPortalShell } from "@/components/dashboard/developers/developers-portal-shell";
import { fetchCoreJson } from "@/lib/core-server-api";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fallbackDevelopersConfig, type DevelopersBootstrap } from "@/lib/developers";
import { redirect } from "react-router";

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");

  const bootstrap = await fetchCoreJson<DevelopersBootstrap>("/api/developers").catch(() => ({
    apiKeys: [],
    config: fallbackDevelopersConfig,
  }));

  return { bootstrap };
}

export default function DevelopersLayout() {
  const { bootstrap } = useLoaderData<typeof clientLoader>();
  return <DevelopersPortalShell initial={bootstrap}><Outlet /></DevelopersPortalShell>;
}
