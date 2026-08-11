import { Bot, ChartColumn, Sparkles } from "lucide-react";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = { title: "Agent Analytics | KasiTek" };

type Agent = { id: string; name: string; protected: boolean; status: string };

export default async function AgentAnalyticsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const response = await fetchRustJson<{ agents: Agent[] }>("/api/agents").catch(() => ({ agents: [] }));
  const active = response.agents.filter((agent) => agent.status === "active").length;
  const protectedCount = response.agents.filter((agent) => agent.protected).length;
  const metrics = [
    { label: "Installed agents", value: response.agents.length, icon: Bot },
    { label: "Active agents", value: active, icon: ChartColumn },
    { label: "System agents", value: protectedCount, icon: Sparkles },
  ];

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent analytics</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Workspace-level installation status from the Agent Platform. Run and model metrics will be connected to the operational view next.</p>
        </header>
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          {metrics.map((metric) => (
            <article key={metric.label} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">{metric.label}</p><metric.icon className="h-4 w-4 text-muted-foreground" /></div>
              <p className="mt-5 text-3xl font-semibold tracking-tight text-foreground">{metric.value}</p>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
