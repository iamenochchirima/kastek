"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, Check, ChevronRight, Info, Plus, Sparkles } from "lucide-react";
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
  if (status === "active") return "border-accent/30 bg-accent/10 text-accent";
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
    ? "border-accent/20 bg-accent/10 text-accent"
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
  const templates: SelectableTemplate[] = initialTemplates.map((template) => ({ value: template.key, label: template.name, description: template.description, available: true }));

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-7">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agents</h1>
          </div>
          <div className="flex flex-wrap gap-2"><Button asChild type="button" variant="outline"><Link href="/developers/api-keys">Developer API keys</Link></Button><Button asChild type="button"><Link href="/agents/new/general">Create general-purpose agent</Link></Button><Button asChild type="button" variant="outline"><Link href="/agents/new">Build custom agent</Link></Button><Button type="button" variant="outline" className="gap-2" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />Browse custom templates</Button></div>
        </header>

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
              <div className="flex flex-wrap gap-2"><Button asChild type="button"><Link href="/agents/new/general">Create general-purpose agent</Link></Button><Button asChild type="button" variant="outline"><Link href="/agents/new">Build custom agent</Link></Button></div>
            </CardContent>
          </Card>
        )}
      </div>

      {createOpen ? <TemplateDialog templates={templates} onClose={() => setCreateOpen(false)} initialTemplateKey={initialTemplateKey} /> : null}
    </div>
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
          {isKasiAi ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-accent"><Check className="h-3.5 w-3.5" />Available from the sidebar</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="agent-template-title">
      <button type="button" className="absolute inset-0 bg-overlay" aria-label="Close templates" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
            <h2 id="agent-template-title" className="mt-1 text-xl font-semibold text-foreground">Choose an agent template</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose a blueprint, then review and finish it in the custom builder.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close templates"><ChevronRight className="h-4 w-4 rotate-45" /></Button>
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
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{template.label}</span><Badge className={template.available ? "border-accent/20 bg-accent/10 text-accent" : "border-border bg-secondary text-muted-foreground"}>{template.available ? "Available" : "Coming soon"}</Badge></div>
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
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={step === "select" ? onClose : () => setStep(step === "review" ? "configure" : "select")}>{step === "select" ? "Close" : "Back"}</Button>
          {step === "configure" ? <Button type="button" disabled={!selectedTemplate?.available} onClick={() => setStep("review")}>Review</Button> : null}
          {step === "review" && selectedTemplate ? <Button asChild type="button"><Link href={`/agents/new?template=${encodeURIComponent(selectedTemplate.value)}`}>Open custom builder</Link></Button> : null}
        </div>
      </div>
    </div>
  );
}
