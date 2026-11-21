import { useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentSummary } from "./api";
import { useWorkspace } from "./shell";
import { AgentAvatar } from "./agent-avatar";
import { EditAgentDialog } from "./edit-agent-dialog";
import "./agent-landing.css";

type LandingAgent = AgentSummary & { avatar?: string | null; offering?: string | null; responsibilities?: string[] | null; activeChannels?: string[] | null };
type Props = { agents: LandingAgent[] | null; plan?: string | null; search: string; onSearch: (value: string) => void; filter: string; onFilter: (value: string) => void; error: string; onRetry: () => void; hasMore: boolean; onMore: () => void; busy: boolean; canCreate: boolean; onCreate: () => void };
const responsibilityLabels: Record<string, string> = { "answer-questions": "Answer questions", "customer-support": "Handle support", bookings: "Book appointments", enquiries: "Collect enquiries" };
const labelOffering = (offering?: string | null) => offering === "customer-service" ? "Customer service" : offering === "faq" ? "FAQ" : offering ? offering.replace(/[-_]/g, " ") : "Agent";
const role = (agent: LandingAgent) => labelOffering(agent.offering);
const purpose = (agent: LandingAgent) => agent.responsibilities?.map(item => responsibilityLabels[item] ?? item.replace(/[-_]/g, " ")).join(", ") || "—";
const status = (agent: LandingAgent) => !agent.latestVersion ? "Setup" : agent.hasUnpublishedChanges ? "Changes pending" : "Configured";

export function AgentLanding({ agents, plan, search, onSearch, filter, onFilter, error, onRetry, hasMore, onMore, busy, canCreate, onCreate }: Props) {
  const { organizationId } = useWorkspace();
  const [editing, setEditing] = useState<LandingAgent | null>(null);
  return <div className="agent-landing">
    <section className="agent-landing-main">
      <header className="agent-landing-header"><div><h1>Your agents</h1></div>{canCreate ? <Button onClick={onCreate}><HugeiconsIcon icon={Add01Icon} size={18} aria-hidden="true" />Create agent</Button> : null}</header>
      <div className="agent-landing-filters"><label className="agent-landing-search"><HugeiconsIcon icon={Search01Icon} size={18} aria-hidden="true" /><Input aria-label="Search agents" placeholder="Search agents..." value={search} onChange={event => onSearch(event.target.value)} /></label><select aria-label="Filter agents" className="agent-landing-filter" value={filter} onChange={event => onFilter(event.target.value)}><option value="all">All agents</option><option value="configured">Configured</option><option value="changes-pending">Changes pending</option><option value="setup">Setup</option></select></div>
      {error ? <div role="alert" className="agent-landing-error"><span>{error}</span><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div> : null}
      {!agents && !error ? <div className="agent-landing-loading" role="status">Loading agents…</div> : agents?.length ? <div className="agent-card-grid" aria-label="Agents">
        {agents.map(agent => <article className="agent-card" key={agent.id}>
          <div className="agent-card-top"><AgentAvatar id={agent.avatar} size={46} />{canCreate ? <Button className="agent-card-edit" size="sm" variant="ghost" aria-label={`Edit ${agent.name}`} title="Edit agent" onClick={() => setEditing(agent)}>···</Button> : null}</div>
          <Link className="agent-card-body" to={`/app/agents/${agent.id}`} aria-label={`Open ${agent.name}`}><strong>{agent.name}</strong><span className="agent-card-role">{role(agent)}</span><span className="agent-card-purpose">{purpose(agent)}</span></Link>
          <div className="agent-card-foot"><span className="agent-landing-status" data-status={status(agent)}>{status(agent)}</span><Link className="agent-card-action" to={canCreate && status(agent) === "Setup" ? `/app/agents/${agent.id}?${agent.offering ? "setup=guided" : "section=behaviour"}` : `/app/agents/${agent.id}`}>{canCreate && status(agent) === "Setup" ? "Set up" : "Open"}</Link></div>
        </article>)}
      </div> : agents && !error ? <div className="agent-landing-empty"><p>{search.trim() || filter !== "all" ? "No matching agents" : "No agents yet"}</p>{canCreate && !search.trim() && filter === "all" ? <div className="flex flex-wrap justify-center gap-2"><Button variant="outline" onClick={onCreate}>Create agent</Button>{plan?.endsWith("-free") ? <Button variant="ghost" asChild><Link to="/app/settings/billing">View plans</Link></Button> : null}</div> : null}</div> : null}
      {hasMore ? <Button className="agent-landing-more" variant="outline" size="sm" onClick={onMore} disabled={busy}>{busy ? "Loading…" : "Load more"}</Button> : null}
    </section>
    <EditAgentDialog organizationId={organizationId} agent={editing} role={editing ? role(editing) : "Agent"} onOpenChange={open => { if (!open) setEditing(null); }} onSaved={() => onRetry()} />
  </div>;
}
