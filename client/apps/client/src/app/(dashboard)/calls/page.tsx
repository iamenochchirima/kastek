import {
  CallsWorkspace,
  type CallProviderStatus,
  type CallRecord,
  type CallSummary,
} from "@/components/dashboard/calls/calls-workspace";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Calls | KasiTek",
};

export default async function CallsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [callsResponse, summaryResponse, providerResponse] = await Promise.all([
    fetchRustJson<{ calls: CallRecord[] }>("/api/calls").catch(() => ({ calls: [] })),
    fetchRustJson<CallSummary>("/api/calls/summary").catch(() => null),
    fetchRustJson<CallProviderStatus>("/api/calls/providers").catch(() => null),
  ]);

  return (
    <CallsWorkspace
      initialCalls={callsResponse.calls || []}
      summary={summaryResponse}
      providers={providerResponse}
    />
  );
}
