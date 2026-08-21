"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
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
import { ArrowLeft, Bot, Info, MessageSquare, Sparkles } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setAgentInstallationStatus, type AgentDefinition, type AgentOperationsSummary, type AgentTemplate } from "@/lib/agent-platform";

export type AgentListItem = AgentDefinition;

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

function modeLabel(agent: AgentDefinition): string {
  const mode = agent.execution_mode ?? (agent.protected ? "system_hosted" : "kasitek_hosted");
  if (mode === "system_hosted") return "KasiAi";
  if (mode === "external_connected") return "External connected";
  return "KasiTek hosted";
}

function modeClass(agent: AgentDefinition): string {
  return agent.execution_mode === "external_connected"
    ? "border-status-info/30 bg-status-info-soft text-status-info"
    : agent.protected
      ? "border-primary/20 bg-primary/10 text-primary"
      : "border-border bg-secondary text-muted-foreground";
}

function creationProfileLabel(agent: AgentDefinition): string | null {
  if ((agent.execution_mode ?? (agent.protected ? "system_hosted" : "kasitek_hosted")) !== "kasitek_hosted") return null;
  return agent.creation_profile === "general" ? "General-purpose" : "Custom";
}

export function AgentsPageClient({
  initialAgents,
  initialTemplates,
  initialTemplateKey,
  agentsUnavailable = false,
  initialOperations = null,
}: {
  initialAgents: AgentListItem[];
  initialTemplates: AgentTemplate[];
  initialTemplateKey?: string;
  agentsUnavailable?: boolean;
  initialOperations?: AgentOperationsSummary | null;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(Boolean(initialTemplateKey));
  const [createStep, setCreateStep] = useState<"type" | "custom">("type");
  const templates: SelectableTemplate[] = initialTemplates.map((template) => ({ value: template.key, label: template.name, description: template.description, available: true }));

  const closeCreate = () => {
    setCreateOpen(false);
    setCreateStep("type");
  };

  const openCreateRoute = (path: string) => {
    closeCreate();
    router.push(path);
  };

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Agents</PageHeaderTitle>
            <PageHeaderDescription>Installed agents.</PageHeaderDescription>
          </PageHeaderContent>
          <PageHeaderActions>
          <Button type="button" onClick={() => { setCreateStep("type"); setCreateOpen(true); }}>Create agent</Button>
          </PageHeaderActions>
        </PageHeader>

        {initialOperations ? <OperationsSummary summary={initialOperations} /> : null}

        {agentsUnavailable ? (
          <Card><CardContent className="flex flex-col items-start gap-4 p-8"><Info className="h-7 w-7 text-status-attention" /><div><h2 className="text-xl font-semibold text-foreground">Agents are unavailable</h2><p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">The Agent Platform could not be reached. Your existing installations are unchanged; try refreshing in a moment.</p></div><Button type="button" variant="outline" onClick={() => router.refresh()}>Retry</Button></CardContent></Card>
        ) : initialAgents.length ? (
          <section className="grid gap-4 lg:grid-cols-2" aria-label="Installed agents">
            {initialAgents.map((agent) => <AgentCard key={agent.id} agent={agent} onChanged={() => router.refresh()} />)}
          </section>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-start gap-4 p-8">
              <Sparkles className="h-7 w-7 text-primary" />
              <div>
                <h2 className="text-xl font-semibold text-foreground">No installed agents yet</h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">Install KasiAi or choose an available template to get started.</p>
              </div>
              <Button type="button" onClick={() => { setCreateStep("type"); setCreateOpen(true); }}>Create agent</Button>
            </CardContent>
          </Card>
        )}
      </div>

      {createOpen ? initialTemplateKey ? (
        <TemplateDialog templates={templates} onClose={closeCreate} initialTemplateKey={initialTemplateKey} />
      ) : (
        <CreateAgentDialog step={createStep} onStepChange={setCreateStep} onClose={closeCreate} onChooseGeneral={() => openCreateRoute("/agents/new/general")} onChooseCustom={() => setCreateStep("custom")} onBrowseTemplates={() => openCreateRoute("/agents/templates")} onStartFromScratch={() => openCreateRoute("/agents/new")} />
      ) : null}
    </div>
  );
}

function CreateAgentDialog({
  step,
  onStepChange,
  onClose,
  onChooseGeneral,
  onChooseCustom,
  onBrowseTemplates,
  onStartFromScratch,
}: {
  step: "type" | "custom";
  onStepChange: (step: "type" | "custom") => void;
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
            <DialogDescription>Choose a starting point.</DialogDescription>
          </DialogHeader>
        </div>

        {step === "type" ? (
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

function AgentCard({ agent, onChanged }: { agent: AgentDefinition; onChanged: () => void }) {
  const isKasiAi = (agent.execution_mode ?? (agent.protected ? "system_hosted" : "kasitek_hosted")) === "system_hosted";
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
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
              {isKasiAi ? <Sparkles className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground"><Link className="hover:text-primary" href={`/agents/${encodeURIComponent(agent.id)}`}>{agent.name}</Link></h2>
              <p className="mt-1 text-sm text-muted-foreground">{agent.description || "Installed Agent Platform agent"}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Badge className={modeClass(agent)}>{modeLabel(agent)}</Badge>
            {creationProfileLabel(agent) ? <Badge className="border-border bg-secondary text-muted-foreground">{creationProfileLabel(agent)}</Badge> : null}
            <Badge className={statusClass(agent.installation_status ?? agent.status)}>{agent.installation_status ?? agent.status}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>Slug: {agent.slug}</span>
          <span>Created {new Date(agent.created_at).toLocaleDateString()}</span>
          {agent.version_number ? <span>Version {agent.version_number}</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild type="button" variant="outline" size="sm"><Link href={`/agents/${encodeURIComponent(agent.id)}`}>Open details</Link></Button>
          {!isKasiAi && agent.execution_mode !== "external_connected" ? <Button asChild type="button" size="sm"><Link href={`/agents/${encodeURIComponent(agent.id)}?section=activity`}><MessageSquare className="mr-1.5 h-3.5 w-3.5" />Chat</Link></Button> : null}
          {isKasiAi ? (
            <Button asChild type="button" size="sm"><Link href={`/agents/${encodeURIComponent(agent.id)}?section=activity`}><MessageSquare className="mr-1.5 h-3.5 w-3.5" />Chat</Link></Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={!agent.installation_id || updating} onClick={() => void toggleStatus()}>
              {updating ? "Updating…" : installationStatus === "active" ? "Pause agent" : "Resume agent"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
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
