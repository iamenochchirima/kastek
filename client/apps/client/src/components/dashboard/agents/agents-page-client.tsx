"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { ArrowLeft, Bot, Info, MessageSquare, Sparkles, UserRound, X } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setAgentInstallationStatus, type AgentAudience, type AgentAudienceCounts, type AgentDefinition, type AgentOperationsSummary, type AgentTemplate } from "@/lib/agent-platform";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { AgentChatPanel } from "./agent-chat-panel";

export type AgentListItem = AgentDefinition;
export type AgentView = "agents" | "external";

type SelectableTemplate = {
  value: string;
  label: string;
  description: string;
  available: boolean;
};

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

export function AgentsPageClient({
  initialAgents,
  initialCounts,
  initialTemplates,
  initialTemplateKey,
  initialView = "agents",
  agentsUnavailable = false,
  initialOperations = null,
}: {
  initialAgents: AgentListItem[];
  initialCounts?: AgentAudienceCounts;
  initialTemplates: AgentTemplate[];
  initialTemplateKey?: string;
  initialView?: AgentView;
  agentsUnavailable?: boolean;
  initialOperations?: AgentOperationsSummary | null;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(Boolean(initialTemplateKey));
  const [createStep, setCreateStep] = useState<"audience" | "type" | "custom">("audience");
  const [createAudience, setCreateAudience] = useState<AgentAudience>("personal");
  const [chatAgent, setChatAgent] = useState<AgentDefinition | null>(null);
  const [activeView, setActiveView] = useState<AgentView>(initialView);
  const templates: SelectableTemplate[] = initialTemplates.map((template) => ({ value: template.key, label: template.name, description: template.description, available: true }));
  const visibleAgents = initialAgents.filter((agent) => activeView === "external" ? isExternalAgent(agent) : !isExternalAgent(agent));

  const closeCreate = () => {
    setCreateOpen(false);
    setCreateStep("audience");
    setCreateAudience("personal");
  };

  const openCreateRoute = (path: string) => {
    closeCreate();
    router.push(path);
  };

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Agents</PageHeaderTitle>
            <PageHeaderDescription>Installed agents.</PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions>
          <Button type="button" onClick={() => { setCreateStep("audience"); setCreateOpen(true); }}>Create agent</Button>
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
              {activeView === "agents" ? <Button type="button" onClick={() => { setCreateStep("audience"); setCreateOpen(true); }}>Create agent</Button> : null}
            </CardContent>
          </Card>
        )}
      </div>

      {createOpen ? initialTemplateKey ? (
        <TemplateDialog templates={templates} onClose={closeCreate} initialTemplateKey={initialTemplateKey} />
      ) : (
        <CreateAgentDialog audience={createAudience} step={createStep} onAudienceChange={setCreateAudience} onStepChange={setCreateStep} onClose={closeCreate} onChooseGeneral={() => openCreateRoute(`/agents/new/general?audience=${createAudience}`)} onChooseCustom={() => setCreateStep("custom")} onBrowseTemplates={() => openCreateRoute(`/agents/templates?audience=${createAudience}`)} onStartFromScratch={() => openCreateRoute(`/agents/new?audience=${createAudience}`)} />
      ) : null}
      {chatAgent?.installation_id ? <AgentChatDialog agent={chatAgent} onClose={() => setChatAgent(null)} /> : null}
    </div>
  );
}

function CreateAgentDialog({
  audience,
  step,
  onAudienceChange,
  onStepChange,
  onClose,
  onChooseGeneral,
  onChooseCustom,
  onBrowseTemplates,
  onStartFromScratch,
}: {
  audience: AgentAudience;
  step: "audience" | "type" | "custom";
  onAudienceChange: (audience: AgentAudience) => void;
  onStepChange: (step: "audience" | "type" | "custom") => void;
  onClose: () => void;
  onChooseGeneral: () => void;
  onChooseCustom: () => void;
  onBrowseTemplates: () => void;
  onStartFromScratch: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <DialogHeader>
            <DialogTitle>Create an agent</DialogTitle>
            <DialogDescription>{step === "audience" ? "Choose who it will serve." : "Choose a starting point."}</DialogDescription>
          </DialogHeader>
        </div>

        {step === "audience" ? (
          <div className="mt-6 grid items-stretch gap-4 sm:grid-cols-2">
            <button type="button" onClick={() => { onAudienceChange("personal"); onStepChange("type"); }} className={`flex min-h-[244px] flex-col rounded-xl border p-6 text-left transition-colors ${audience === "personal" ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/60 hover:bg-secondary/35"}`}>
              <UserRound className="h-6 w-6 text-primary" />
              <h3 className="mt-5 text-base font-semibold text-foreground">Personal agent</h3>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">Private assistant for your own work, knowledge, and test chats.</p>
              <span className="mt-auto pt-5 text-sm font-medium text-primary">Continue</span>
            </button>
            <button type="button" onClick={() => { onAudienceChange("customer_service"); onStepChange("type"); }} className={`flex min-h-[244px] flex-col rounded-xl border p-6 text-left transition-colors ${audience === "customer_service" ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/60 hover:bg-secondary/35"}`}>
              <MessageSquare className="h-6 w-6 text-primary" />
              <h3 className="mt-5 text-base font-semibold text-foreground">Customer service agent</h3>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">Customer-facing assistant with channels and human handoff support.</p>
              <span className="mt-auto pt-5 text-sm font-medium text-primary">Continue</span>
            </button>
          </div>
        ) : step === "type" ? (
          <div className="mt-6 grid items-stretch gap-4 sm:grid-cols-2">
            <div className="flex min-h-[284px] flex-col rounded-xl border border-border bg-card p-6 text-center transition-colors hover:border-primary/60 hover:bg-secondary/35">
              <h3 className="text-base font-semibold text-foreground">General-purpose agent</h3>
              <p className="mx-auto mt-3 max-w-xs text-sm leading-5 text-muted-foreground">A complete assistant for a common job. Give it a name, purpose, and a few preferences.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-1.5" aria-label="Common general-purpose use cases">
                {['Customer support', 'Lead qualification', 'Booking assistant', 'Internal helpdesk'].map((useCase) => <span key={useCase} className="rounded-full border border-border bg-secondary px-2 py-1 text-[11px] text-muted-foreground">{useCase}</span>)}
              </div>
              <Button type="button" className="mx-auto mt-auto w-full max-w-[210px]" onClick={onChooseGeneral}>Choose general-purpose</Button>
            </div>
            <div className="flex min-h-[284px] flex-col rounded-xl border border-border bg-card p-6 text-center transition-colors hover:border-primary/60 hover:bg-secondary/35">
              <h3 className="text-base font-semibold text-foreground">Custom agent</h3>
              <p className="mx-auto mt-3 max-w-xs text-sm leading-5 text-muted-foreground">Build a workflow from a canvas. Connect tools, knowledge, channels, and services when you need them.</p>
              <Button type="button" variant="outline" className="mx-auto mt-auto w-full max-w-[210px]" onClick={onChooseCustom}>Choose custom</Button>
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <button type="button" onClick={() => onStepChange("type")} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="mr-1.5 h-4 w-4" />Back</button>
            <div className="grid items-stretch gap-4 sm:grid-cols-2">
              <div className="flex min-h-[218px] flex-col rounded-xl border border-border bg-card p-6 text-center transition-colors hover:border-primary/60 hover:bg-secondary/35">
                <h3 className="text-base font-semibold text-foreground">Start from scratch</h3>
                <p className="mx-auto mt-3 max-w-xs text-sm leading-5 text-muted-foreground">Build your agent on a clean workflow canvas.</p>
                <Button type="button" className="mx-auto mt-auto w-full max-w-[190px]" onClick={onStartFromScratch}>Start from scratch</Button>
              </div>
              <div className="flex min-h-[218px] flex-col rounded-xl border border-border bg-card p-6 text-center transition-colors hover:border-primary/60 hover:bg-secondary/35">
                <h3 className="text-base font-semibold text-foreground">Browse templates</h3>
                <p className="mx-auto mt-3 max-w-xs text-sm leading-5 text-muted-foreground">Choose a prepared workflow, then configure its services.</p>
                <Button type="button" variant="outline" className="mx-auto mt-auto w-full max-w-[190px]" onClick={onBrowseTemplates}>Browse templates</Button>
              </div>
            </div>
          </div>
        )}
        <DialogFooter className="mt-6 border-t border-border pt-4"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
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

function TemplateDialog({ templates, onClose, initialTemplateKey }: { templates: SelectableTemplate[]; onClose: () => void; initialTemplateKey?: string }) {
  const [selected, setSelected] = useState(initialTemplateKey ?? "");
  const [step, setStep] = useState<"select" | "configure" | "review">(initialTemplateKey ? "configure" : "select");
  const selectedTemplate = templates.find((template) => template.value === selected);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] max-w-3xl overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <DialogHeader>
            <DialogTitle>Choose an agent template</DialogTitle>
            <DialogDescription>Choose a blueprint, then configure it in the builder.</DialogDescription>
          </DialogHeader>
        </div>
        {step === "select" ? <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <button
              key={template.value}
              type="button"
              disabled={!template.available}
              onClick={() => { setSelected(template.value); setStep("configure"); }}
              className={`rounded-xl border p-4 text-left transition-colors ${selected === template.value ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/40"} ${!template.available ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{template.label}</span><Badge className={template.available ? "border-status-success/30 bg-status-success-soft text-status-success" : "border-border bg-secondary text-muted-foreground"}>{template.available ? "Available" : "Coming soon"}</Badge></div>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">{template.description}</p>
            </button>
          ))}
        </div> : null}
        {step === "configure" && selectedTemplate ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-border bg-card p-4"><p className="text-sm font-semibold text-foreground">{selectedTemplate.label}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">{selectedTemplate.description}</p><p className="mt-3 text-xs text-muted-foreground">This blueprint supplies the starting instructions and policy. You will review capabilities, connections, and the workflow before publishing.</p></div>
          </div>
        ) : null}
        {step === "review" && selectedTemplate ? <div className="mt-6 space-y-4"><h3 className="font-semibold text-foreground">Open the custom builder</h3><dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm"><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Blueprint</dt><dd className="font-medium text-foreground">{selectedTemplate.label}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">What happens next</dt><dd className="max-w-[65%] text-right font-medium text-foreground">Instructions, policy, and configuration load into an editable draft</dd></div></dl><p className="text-sm text-muted-foreground">Nothing is installed from this preview. The builder creates a draft, validates it, and only publishes after you review it.</p></div> : null}
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" onClick={step === "select" ? onClose : () => setStep(step === "review" ? "configure" : "select")}>{step === "select" ? "Close" : "Back"}</Button>
          {step === "configure" ? <Button type="button" disabled={!selectedTemplate?.available} onClick={() => setStep("review")}>Review</Button> : null}
          {step === "review" && selectedTemplate ? <Button asChild type="button"><Link href={`/agents/new?template=${encodeURIComponent(selectedTemplate.value)}`}>Open custom builder</Link></Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
