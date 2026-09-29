import { redirect } from "next/navigation";
import { getRustSession } from "@/lib/rust-auth";
import { StudioAgentCreationPage } from "@/components/dashboard/studio/studio-agent-creation-page";

export const metadata = { title: "Create agent | Studio | KasiTek" };

export default async function StudioAgentCreationRoute() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  return <StudioAgentCreationPage />;
}
