import { redirect } from "@/lib/navigation";
import { getSession } from "@/lib/session";

export const metadata = { title: "Test | KasiTek" };

export default async function PlaygroundRoute({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const { agent } = await searchParams;
  if (!agent) redirect("/agents");
  redirect(`/agents/${encodeURIComponent(agent)}?section=test`);
}
