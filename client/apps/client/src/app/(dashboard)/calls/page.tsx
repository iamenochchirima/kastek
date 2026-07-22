import { CallsWorkspace, type CallRecord, type CallSummary } from "@/components/dashboard/calls/calls-workspace";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Calls | KasiTek",
};

export default async function CallsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [callsResponse, summaryResponse] = await Promise.all([
    fetchRustJson<{ calls: CallRecord[] }>("/api/whatsapp/calls").catch(() => ({ calls: [] })),
    fetchRustJson<CallSummary>("/api/whatsapp/calls/summary").catch(() => null),
  ]);

  return <CallsWorkspace initialCalls={callsResponse.calls || []} summary={summaryResponse} />;
}
