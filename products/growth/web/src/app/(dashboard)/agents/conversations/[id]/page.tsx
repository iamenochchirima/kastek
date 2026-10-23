import { redirect } from "next/navigation";
import { getWorkspaceSession } from "@/lib/core-auth";
import { GrowthConversationPage } from "@/components/dashboard/agents/conversation-page";

export const metadata = { title: "Agent conversation | KasiTek" };
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await getWorkspaceSession()) redirect("/login");
  const { id } = await params;
  return <GrowthConversationPage conversationId={id} />;
}
