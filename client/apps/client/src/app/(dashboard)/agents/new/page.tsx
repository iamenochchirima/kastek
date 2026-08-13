import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import { CreateAgentPageClient } from "@/components/dashboard/agents/create-agent-page-client";

export const metadata = { title: "Create agent | KasiTek" };

export default async function CreateAgentPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  return <CreateAgentPageClient />;
}
