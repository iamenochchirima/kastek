import { redirect } from "next/navigation";
import { getRustSession } from "@/lib/rust-auth";

export const metadata = { title: "Connect external agent | KasiTek" };

export default async function AgentConnectPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  redirect("/developers/api-keys");
}
