"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { Bot, Info, MessageSquare, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "@/lib/navigation";
import { setAgentInstallationStatus, type AgentAudienceCounts, type AgentDefinition, type AgentOperationsSummary } from "@/lib/agent-platform";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { AgentChatPanel } from "./agent-chat-panel";
import { listAgentCreationDrafts, type AgentCreationDraftSummary } from "@/lib/agent-creation-drafts";

export type AgentListItem = AgentDefinition;
export type AgentView = "agents" | "external";

function statusClass(status: string) {
  if (status === "active") return "border-status-success/30 bg-status-success-soft text-status-success";
  if (status === "paused") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-border bg-secondary text-muted-foreground";
}

function agentExecutionMode(agent: AgentDefinition): NonNullable<AgentDefinition["execution_mode"]> {
  return agent.execution_mode ?? (agent.protected ? "system_hosted" : "kasitek_hosted");
}

function isExternalAgent(agent: AgentDefinition): boolean {
  return agentExecutionMode(agent) === "external_connected";
}

function modeLabel(agent: AgentDefinition): string {
  const mode = agentExecutionMode(agent);
  if (mode === "system_hosted") return "KasiAI";
  if (mode === "external_connected") return "External connected";
  return "KasiTek hosted";
}

function modeClass(agent: AgentDefinition): string {
  const mode = agentExecutionMode(agent);
  if (mode === "external_connected") return "border-status-info/30 bg-status-info-soft text-status-info";
  if (mode === "system_hosted") return "border-primary/20 bg-primary/10 text-primary";
  return "border-border bg-secondary text-muted-foreground";
}

function creationProfileLabel(agent: AgentDefinition): string | null {
  if (agentExecutionMode(agent) !== "kasitek_hosted") return null;
  return agent.creation_profile === "general" ? "General-purpose" : "Custom";
}

function audienceLabel(agent: AgentDefinition): string {
  return agent.agent_audience === "customer_service" ? "Customer service" : "Personal";
}

function audienceClass(agent: AgentDefinition): string {
  return agent.agent_audience === "customer_service"
    ? "border-status-info/30 bg-status-info-soft text-status-info"
    : "border-border bg-secondary text-muted-foreground";
}

function draftPath(draft: AgentCreationDraftSummary): string {
  const params = new URLSearchParams({ flow: draft.kind, audience: draft.audience });
  if (draft.templateKey) params.set("template", draft.templateKey);
  return `/agents/new?${params.toString()}`;
}

function draftStepLabel(draft: AgentCreationDraftSummary): string {
  const step = draft.step ?? 1;
  if (draft.kind === "general") return `Step ${step} of 4`;
  return `Step ${step} of 5`;
}

export function AgentsPageClient({
  initialAgents,
  initialCounts,
  initialTemplateKey,
  userId,
  initialView = "agents",
  agentsUnavailable = false,
  initialOperations = null,
}: {
  initialAgents: AgentListItem[];
  initialCounts?: AgentAudienceCounts;
  initialTemplateKey?: string;
  userId?: string;
  initialView?: AgentView;
  agentsUnavailable?: boolean;
  initialOperations?: AgentOperationsSummary | null;
}) {
  const router = useRouter();
  const [chatAgent, setChatAgent] = useState<AgentDefinition | null>(null);
  const [activeView, setActiveView] = useState<AgentView>(initialView);
  const [browserDrafts, setBrowserDrafts] = useState<AgentCreationDraftSummary[]>([]);
  const visibleAgents = initialAgents.filter((agent) => activeView === "external" ? isExternalAgent(agent) : !isExternalAgent(agent));

  useEffect(() => {
    const refreshDrafts = () => setBrowserDrafts(listAgentCreationDrafts(userId));
    refreshDrafts();
    const handleFocus = () => refreshDrafts();
    const handleStorage = () => refreshDrafts();
    window.addEventListener("focus", handleFocus);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("storage", handleStorage);
    };
  }, [userId]);

  useEffect(() => {
    if (!initialTemplateKey) return;
    router.replace(`/agents/new?flow=custom&audience=personal&template=${encodeURIComponent(initialTemplateKey)}`);
  }, [initialTemplateKey, router]);

  const openCreate = () => router.push("/agents/new");

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Agents</PageHeaderTitle>
            <PageHeaderDescription>Installed agents.</PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions>
          <Button type="button" onClick={openCreate}>Create agent</Button>
          </PageHeaderActions>
        </PageHeader>

        {initialOperations ? <OperationsSummary summary={initialOperations} /> : null}
        {initialCounts ? <AudienceSummary counts={initialCounts} /> : null}

        <div role="tablist" aria-label="Agent views" className="flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-secondary/40 p-1">
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "agents"}
            onClick={() => setActiveView("agents")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeView === "agents" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            Agents
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "external"}
            onClick={() => setActiveView("external")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeView === "external" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            External agents
          </button>
        </div>

        {activeView === "agents" && browserDrafts.length ? <section aria-labelledby="unfinished-drafts-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h2 id="unfinished-drafts-heading" className="text-lg font-semibold text-foreground">Unfinished drafts</h2><p className="mt-1 text-sm text-muted-foreground">Continue where you left off.</p></div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">{browserDrafts.map((draft) => <CreationDraftCard key={draft.key} draft={draft} onResume={() => router.push(draftPath(draft))} />)}</div>
        </section> : null}

        {agentsUnavailable ? (
          <Card><CardContent className="flex flex-col items-start gap-4 p-8"><Info className="h-7 w-7 text-status-attention" /><div><h2 className="text-xl font-semibold text-foreground">Agents are unavailable</h2><p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">The Agent Platform could not be reached. Your existing installations are unchanged; try refreshing in a moment.</p></div><Button type="button" variant="outline" onClick={() => router.refresh()}>Retry</Button></CardContent></Card>
        ) : visibleAgents.length ? (
          <section className="grid gap-4 lg:grid-cols-2" aria-label="Installed agents">
            {visibleAgents.map((agent, index) => <AgentCard key={agent.id} agent={agent} onChanged={() => router.refresh()} onChat={() => setChatAgent(agent)} onOpenDetails={() => router.push(`/agents/${encodeURIComponent(agent.id)}`)} delay={0.08 + index * 0.06} />)}
          </section>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-start gap-4 p-8">
              <Sparkles className="h-7 w-7 text-primary" />
              <div>
                <h2 className="text-xl font-semibold text-foreground">{activeView === "external" ? "No external agents yet" : "No installed agents yet"}</h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">{activeView === "external" ? "External connections will appear here." : "Install KasiAI or choose an available template to get started."}</p>
              </div>
              {activeView === "agents" ? <Button type="button" onClick={openCreate}>Create agent</Button> : null}
            </CardContent>
          </Card>
        )}
      </div>

      {chatAgent?.installation_id ? <AgentChatDialog agent={chatAgent} onClose={() => setChatAgent(null)} /> : null}
    </div>
  );
}

function CreationDraftCard({ draft, onResume }: { draft: AgentCreationDraftSummary; onResume: () => void }) {
  const isCustom = draft.kind === "custom";
  return (
    <Card className="border-primary/25 bg-primary/[0.03]">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold text-foreground">{draft.name?.trim() || "Untitled agent"}</h3>
            <Badge className="border-primary/20 bg-primary/10 text-primary">Draft</Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{draft.audience === "customer_service" ? "Customer service" : "Personal"}</span>
            <span aria-hidden="true">·</span>
            <span>{isCustom ? "Custom agent" : "General-purpose agent"}</span>
            <span aria-hidden="true">·</span>
            <span>{draftStepLabel(draft)}</span>
          </div>
        </div>
        <Button type="button" variant="outline" className="shrink-0" onClick={onResume}>Resume</Button>
      </CardContent>
    </Card>
  );
}

function OperationsSummary({ summary }: { summary: AgentOperationsSummary }) {
  const runCount = summary.runs.runsByStatus.reduce((total, entry) => total + Number(entry.count || 0), 0);
  const activeCount = summary.runs.runsByStatus.filter((entry) => ["received", "queued", "running", "awaiting_approval", "awaiting_human", "awaiting_external_event"].includes(entry.status)).reduce((total, entry) => total + Number(entry.count || 0), 0);
  const pendingReconciliation = summary.effects?.pendingReconciliation ?? 0;
  return <section aria-label="Agent operations summary" className="grid gap-3 sm:grid-cols-3">
    <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Runs</p><p className="mt-1 text-2xl font-semibold text-foreground">{runCount}</p><p className="mt-1 text-xs text-muted-foreground">{activeCount} active or waiting</p></CardContent></Card>
    <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Tool outcomes</p><p className="mt-1 text-2xl font-semibold text-foreground">{summary.tools.reduce((total, entry) => total + Number(entry.count || 0), 0)}</p><p className="mt-1 text-xs text-muted-foreground">Durable tool invocations</p></CardContent></Card>
    <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Reconciliation</p><p className={`mt-1 text-2xl font-semibold ${pendingReconciliation ? "text-status-attention" : "text-foreground"}`}>{pendingReconciliation}</p><p className="mt-1 text-xs text-muted-foreground">Effects needing operator review</p></CardContent></Card>
  </section>;
}

function AudienceSummary({ counts }: { counts: AgentAudienceCounts }) {
  return <section aria-label="Agent audience summary" className="grid gap-3 sm:grid-cols-3">
    <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Total agents</p><p className="mt-1 text-2xl font-semibold text-foreground">{counts.total}</p><p className="mt-1 text-xs text-muted-foreground">Personal and customer service</p></CardContent></Card>
    <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Personal agents</p><p className="mt-1 text-2xl font-semibold text-foreground">{counts.personal}</p><p className="mt-1 text-xs text-muted-foreground">Private and test assistants</p></CardContent></Card>
    <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Customer service</p><p className="mt-1 text-2xl font-semibold text-foreground">{counts.customer_service}</p><p className="mt-1 text-xs text-muted-foreground">Customer-facing agents</p></CardContent></Card>
  </section>;
}

function AgentCard({ agent, onChanged, onChat, onOpenDetails, delay = 0 }: { agent: AgentDefinition; onChanged: () => void; onChat: () => void; onOpenDetails: () => void; delay?: number }) {
  const isKasiAi = agentExecutionMode(agent) === "system_hosted";
  const canChat = Boolean(agent.installation_id) && !isExternalAgent(agent);
  const [updating, setUpdating] = useState(false);
  const installationStatus = agent.installation_status ?? "disabled";
  const toggleStatus = async () => {
    if (!agent.installation_id || updating) return;
    setUpdating(true);
    try {
      await setAgentInstallationStatus(agent.installation_id, installationStatus === "active" ? "paused" : "active");
      onChanged();
    } finally {
      setUpdating(false);
    }
  };
  return (
    <MotionReveal delay={delay} hoverLift className="h-full">
    <Card
      className={`h-full cursor-pointer transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isKasiAi ? "border-primary/45 bg-primary/[0.04]" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Open ${agent.name}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button,a")) return;
        onOpenDetails();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
              {isKasiAi ? <Sparkles className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">{agent.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{agent.description || "Installed Agent Platform agent"}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Badge className={modeClass(agent)}>{modeLabel(agent)}</Badge>
            <Badge className={audienceClass(agent)}>{audienceLabel(agent)}</Badge>
            {creationProfileLabel(agent) ? <Badge className="border-border bg-secondary text-muted-foreground">{creationProfileLabel(agent)}</Badge> : null}
            <Badge className={statusClass(agent.installation_status ?? agent.status)}>{agent.installation_status ?? agent.status}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>Created {new Date(agent.created_at).toLocaleDateString()}</span>
          {agent.version_number ? <span>Version {agent.version_number}</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {canChat ? <Button type="button" size="sm" onClick={onChat}><MessageSquare className="mr-1.5 h-3.5 w-3.5" />Chat</Button> : null}
          {!isKasiAi ? (
            <Button type="button" variant="outline" size="sm" disabled={!agent.installation_id || updating} onClick={() => void toggleStatus()}>
              {updating ? "Updating…" : installationStatus === "active" ? "Pause agent" : "Resume agent"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
    </MotionReveal>
  );
}

function AgentChatDialog({ agent, onClose }: { agent: AgentDefinition; onClose: () => void }) {
  const active = (agent.installation_status ?? agent.status) === "active";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] max-w-5xl gap-0 overflow-hidden p-0 sm:h-[min(820px,calc(100dvh-2rem))] sm:max-h-[calc(100dvh-2rem)]">
        <DialogTitle className="sr-only">{agent.name} chat</DialogTitle>
        <DialogDescription className="sr-only">Chat with {agent.name}.</DialogDescription>
        <DialogClose asChild>
          <Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3 z-20 bg-card/90" aria-label="Close chat">
            <X className="h-4 w-4" />
          </Button>
        </DialogClose>
        <AgentChatPanel installationId={agent.installation_id!} active={active} agentName={agent.name} modal />
      </DialogContent>
    </Dialog>
  );
}
