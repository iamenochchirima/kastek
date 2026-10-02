import { redirect } from "@/lib/navigation";
import { getSession } from "@/lib/session";

export const metadata = { title: "Connect external agent | KasiTek" };

export default async function AgentConnectPage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  redirect("/developers/api-keys");
}
