import { History } from "lucide-react";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = { title: "Agent Activity | KasiTek" };

type Agent = { id: string; name: string; protected: boolean; status: string };

export default async function AgentActivityPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const response = await fetchRustJson<{ agents: Agent[] }>("/api/agents").catch(() => ({ agents: [] }));

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent activity</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Durable run timelines will appear here as the new Agent Platform activity view is expanded.</p>
        </header>
        <section className="mt-8 rounded-xl border border-border bg-card p-8">
          <History className="h-7 w-7 text-primary" />
          <h2 className="mt-4 text-lg font-semibold text-foreground">Activity is now run-based</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">This view no longer reads the retired bot event system. Open an agent from the Agents page to inspect its durable conversation and run history.</p>
          <div className="mt-6 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {response.agents.map((agent) => <span key={agent.id} className="rounded-full border border-border px-2.5 py-1">{agent.name} · {agent.status}</span>)}
          </div>
        </section>
      </div>
    </div>
  );
}
