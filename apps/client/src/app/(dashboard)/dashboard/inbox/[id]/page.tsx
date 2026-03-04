import { redirect } from "next/navigation";

export default async function LegacyInboxConversationRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/inbox/whatsapp/${id}`);
}
