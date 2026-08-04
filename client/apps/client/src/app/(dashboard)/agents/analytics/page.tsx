import { ChartColumn, CircleAlert, MessageSquare, Zap } from "lucide-react";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = { title: "Agent Analytics | KasiTek" };

type Agent = {
  status: string;
  hitCount: number;
  conversationCount: number;
  handoffCount: number;
  failureCount: number;
  avgResponseTimeMs?: number | null;
};

export default async function AgentAnalyticsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const response = await fetchRustJson<{ bots: Agent[] }>("/api/bots").catch(() => ({ bots: [] }));
  const bots = response.bots;
  const totalHits = bots.reduce((sum, bot) => sum + bot.hitCount, 0);
  const totalConversations = bots.reduce((sum, bot) => sum + bot.conversationCount, 0);
  const totalHandoffs = bots.reduce((sum, bot) => sum + bot.handoffCount, 0);
  const totalFailures = bots.reduce((sum, bot) => sum + bot.failureCount, 0);
  const activeAgents = bots.filter((bot) => bot.status === "active").length;
  const recordedResponseTimes = bots
    .map((bot) => bot.avgResponseTimeMs)
    .filter((value): value is number => typeof value === "number");
  const averageResponseTime = recordedResponseTimes.length
    ? Math.round(recordedResponseTimes.reduce((sum, value) => sum + value, 0) / recordedResponseTimes.length)
    : null;

  const metrics = [
    { label: "Active agents", value: String(activeAgents), detail: `${bots.length} configured`, icon: Zap },
    { label: "Agent conversations", value: totalConversations.toLocaleString(), detail: `${totalHits.toLocaleString()} recorded events`, icon: MessageSquare },
    { label: "Handoffs", value: totalHandoffs.toLocaleString(), detail: "Escalated to a person", icon: ChartColumn },
    { label: "Failures", value: totalFailures.toLocaleString(), detail: averageResponseTime ? `${averageResponseTime} ms average response` : "No response timing yet", icon: CircleAlert },
  ];

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent analytics</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            A workspace-level view of recorded agent activity. More detailed reporting will appear as live agent runs are added.
          </p>
        </header>

        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <article key={metric.label} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-muted-foreground">{metric.label}</p>
                <metric.icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="mt-5 text-3xl font-semibold tracking-tight text-foreground">{metric.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{metric.detail}</p>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
