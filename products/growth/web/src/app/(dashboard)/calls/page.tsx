import { redirect, useLoaderData } from "react-router";
import {
  CallsWorkspace,
  type CallProviderStatus,
  type CallRecord,
  type CallSummary,
  type VoiceConnection,
} from "@/components/dashboard/calls/calls-workspace";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson, ApiError } from "@/lib/core-server-api";

export function meta() {
  return [
    { title: "Calls | KasiTek" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");
  async function read<T>(path: string) {
    try {
      return { data: await fetchCoreJson<T>(path), error: "" };
    } catch (error) {
      return {
        data: null,
        error:
          error instanceof ApiError && error.status === 403
            ? "You do not have access."
            : "Could not load this data.",
      };
    }
  }
  const [calls, summary, providers, connections] = await Promise.all([
    read<{ calls: CallRecord[] }>("/api/calls"),
    read<CallSummary>("/api/calls/summary"),
    read<CallProviderStatus>("/api/calls/providers"),
    read<{ connections: VoiceConnection[] }>("/api/connections"),
  ]);
  return { calls, summary, providers, connections };
}

export default function CallsPage() {
  const data = useLoaderData<typeof clientLoader>();
  return (
    <CallsWorkspace
      initialCalls={data.calls.data?.calls || []}
      summary={data.summary.data}
      providers={data.providers.data}
      voiceConnections={(data.connections.data?.connections || []).filter(
        (connection) => connection.provider === "TWILIO",
      )}
      errors={{
        calls: data.calls.error,
        summary: data.summary.error,
        providers: data.providers.error,
        connections: data.connections.error,
      }}
    />
  );
}
