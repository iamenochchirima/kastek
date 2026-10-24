import { useLoaderData } from "react-router";
import {
  CallsWorkspace,
  type CallProviderStatus,
  type CallRecord,
  type CallSummary,
  type VoiceConnection,
} from "@/components/dashboard/calls/calls-workspace";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";

export function meta() { return [{ title: "Calls | KasiTek" }]; }

export async function clientLoader() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const [callsResponse, summaryResponse, providerResponse, connectionsResponse] = await Promise.all([
    fetchCoreJson<{ calls: CallRecord[] }>("/api/calls").catch(() => ({ calls: [] })),
    fetchCoreJson<CallSummary>("/api/calls/summary").catch(() => null),
    fetchCoreJson<CallProviderStatus>("/api/calls/providers").catch(() => null),
    fetchCoreJson<{ connections: VoiceConnection[] }>("/api/connections").catch(() => ({ connections: [] })),
  ]);

  return { callsResponse, summaryResponse, providerResponse, connectionsResponse };
}

export default function CallsPage() {
  const { callsResponse, summaryResponse, providerResponse, connectionsResponse } = useLoaderData<typeof clientLoader>();
  return (
    <CallsWorkspace
      initialCalls={callsResponse.calls || []}
      summary={summaryResponse}
      providers={providerResponse}
      voiceConnections={(connectionsResponse.connections || []).filter((connection) => connection.provider === "TWILIO")}
    />
  );
}
