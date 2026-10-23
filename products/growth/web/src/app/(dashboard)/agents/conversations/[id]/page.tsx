import { redirect } from "next/navigation";
import { getWorkspaceSession } from "@/lib/core-auth";
import { GrowthConversationPage } from "@/components/dashboard/agents/conversation-page";

export const metadata = { title: "Agent conversation | KasiTek" };
export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ task?: string }> }) {
  if (!await getWorkspaceSession()) redirect("/login");
  const { id } = await params;
  const { task } = await searchParams;
  return <GrowthConversationPage conversationId={id} taskId={task} />;
}
