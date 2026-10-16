import { Link } from "react-router-dom";
import { redirect } from "@/lib/navigation";
import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";
import type { AgentListItem } from "@/components/dashboard/agents/agents-page-client";

export const metadata = { title: "Knowledge | KasiTek" };

export default async function KnowledgePage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const result = await fetchApiJson<{ agents: AgentListItem[] }>("/api/agents")
    .then((response) => ({ agents: response.agents.filter((agent) => agent.execution_mode === "kasitek_hosted"), unavailable: false }))
    .catch(() => ({ agents: [] as AgentListItem[], unavailable: true }));

  return <div className="mx-auto max-w-5xl space-y-6 px-5 py-6 sm:px-8 sm:py-8">
    <header><p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Resources</p><h1 className="mt-2 text-2xl font-semibold text-foreground">Knowledge</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Choose an agent to add text, files or website information it can use when answering.</p></header>
    {result.unavailable ? <section role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">Agent knowledge is unavailable. Check the Agents connection and try again.</section>
      : result.agents.length ? <ul className="grid gap-3 sm:grid-cols-2">{result.agents.map((agent) => <li key={agent.id}><Link className="block rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/app/agents/${encodeURIComponent(agent.id)}?section=knowledge`}><span className="font-medium text-foreground">{agent.name}</span><span className="mt-1 block text-sm text-muted-foreground">Open sources and memory for this agent</span></Link></li>)}</ul>
        : <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-medium text-foreground">No hosted agents yet</h2><p className="mt-2 text-sm text-muted-foreground">Create an agent first, then add its knowledge sources here.</p><Link className="mt-4 inline-flex text-sm font-medium text-primary hover:underline" to="/app/studio/new">Create agent</Link></section>}
  </div>;
}
