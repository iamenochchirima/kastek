import { redirect } from "@/lib/navigation";
import { getSession } from "@/lib/session";
import { StudioAgentCreationPage } from "@/components/dashboard/studio/studio-agent-creation-page";

export const metadata = { title: "Create agent | Studio | KasiTek" };

export default async function StudioAgentCreationRoute() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  return <StudioAgentCreationPage />;
}
