import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import { CreateGeneralAgentPageClient } from "@/components/dashboard/agents/create-general-agent-page-client";

export const metadata = { title: "Create general-purpose agent | KasiTek" };

export default async function CreateGeneralAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { audience } = await searchParams;
  return <CreateGeneralAgentPageClient audience={audience === "customer_service" ? "customer_service" : "personal"} />;
}
