"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, Check, ChevronRight, Info, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ensureKasiAi, installAgentTemplate, setAgentInstallationStatus, type AgentDefinition, type AgentTemplate } from "@/lib/agent-platform";

export type AgentListItem = AgentDefinition;

type SelectableTemplate = {
  value: string;
  label: string;
  description: string;
  available: boolean;
};

const kasiaiTemplate: SelectableTemplate = {
  value: "kasiai",
  label: "KasiAi platform guide",
  description: "Your default KasiTek guide for finding features, understanding settings, and completing platform tasks.",
  available: true,
};

function statusClass(status: string) {
  if (status === "active") return "border-accent/30 bg-accent/10 text-accent";
  if (status === "paused") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-border bg-secondary text-muted-foreground";
}

export function AgentsPageClient({
  initialAgents,
  kasiaiInstallationId,
  initialTemplates,
  initialTemplateKey,
}: {
  initialAgents: AgentListItem[];
  kasiaiInstallationId: string | null;
  initialTemplates: AgentTemplate[];
  initialTemplateKey?: string;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(Boolean(initialTemplateKey));
  const templates: SelectableTemplate[] = [kasiaiTemplate, ...initialTemplates.map((template) => ({ value: template.key, label: template.name, description: template.description, available: true }))];

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-7">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agents</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Manage the agents installed in this workspace. KasiAi is the first protected platform agent; other templates will use the same runtime as they become available.
            </p>
          </div>
          <Button type="button" className="gap-2" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Browse templates
          </Button>
        </header>

        {kasiaiInstallationId ? (
          <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>KasiAi is installed for this workspace. Open it from the sidebar whenever you need platform guidance.</p>
          </div>
        ) : null}

        {initialAgents.length ? (
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
              <Button type="button" onClick={() => setCreateOpen(true)}>Browse templates</Button>
            </CardContent>
          </Card>
        )}
      </div>

      {createOpen ? <TemplateDialog templates={templates} onClose={() => setCreateOpen(false)} onInstalled={() => { setCreateOpen(false); router.refresh(); }} initialTemplateKey={initialTemplateKey} /> : null}
    </div>
  );
}

function AgentCard({ agent, onChanged }: { agent: AgentDefinition; onChanged: () => void }) {
  const isKasiAi = agent.slug === "kasiai";
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
            {agent.protected ? <Badge className="border-primary/20 bg-primary/10 text-primary">System agent</Badge> : null}
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

function TemplateDialog({ templates, onClose, onInstalled, initialTemplateKey }: { templates: SelectableTemplate[]; onClose: () => void; onInstalled: () => void; initialTemplateKey?: string }) {
  const [selected, setSelected] = useState(initialTemplateKey ?? "");
  const [tone, setTone] = useState("balanced");
  const [step, setStep] = useState<"select" | "configure" | "review" | "success">(initialTemplateKey ? "configure" : "select");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTemplate = templates.find((template) => template.value === selected);

  const install = async () => {
    if (!selectedTemplate?.available) return;
    setLoading(true);
    setError(null);
    try {
      if (selectedTemplate.value === "kasiai") {
        await ensureKasiAi();
      } else {
        await installAgentTemplate(selectedTemplate.value, { tone });
      }
      setStep("success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Installation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="agent-template-title">
      <button type="button" className="absolute inset-0 bg-overlay" aria-label="Close templates" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
            <h2 id="agent-template-title" className="mt-1 text-xl font-semibold text-foreground">Choose an agent template</h2>
            <p className="mt-1 text-sm text-muted-foreground">Available templates install through the same durable Agent Platform.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close templates"><ChevronRight className="h-4 w-4 rotate-45" /></Button>
        </div>
        {step === "select" ? <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <button
              key={template.value}
              type="button"
              disabled={!template.available}
              onClick={() => { setSelected(template.value); setStep("configure"); setError(null); }}
              className={`rounded-xl border p-4 text-left transition-colors ${selected === template.value ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/40"} ${!template.available ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{template.label}</span><Badge className={template.available ? "border-accent/20 bg-accent/10 text-accent" : "border-border bg-secondary text-muted-foreground"}>{template.available ? "Available" : "Coming soon"}</Badge></div>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">{template.description}</p>
            </button>
          ))}
        </div> : null}
        {step === "configure" && selectedTemplate ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-border bg-card p-4"><p className="text-sm font-semibold text-foreground">{selectedTemplate.label}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">{selectedTemplate.description}</p></div>
            {selectedTemplate.value !== "kasiai" ? <label className="block text-sm font-medium text-foreground">Response tone<select value={tone} onChange={(event) => setTone(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label> : <p className="rounded-lg bg-primary/5 px-3 py-2 text-sm text-muted-foreground">KasiAi is managed as a protected system agent and does not expose configuration here.</p>}
          </div>
        ) : null}
        {step === "review" && selectedTemplate ? <div className="mt-6 space-y-4"><h3 className="font-semibold text-foreground">Review installation</h3><dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm"><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Template</dt><dd className="font-medium text-foreground">{selectedTemplate.label}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Response tone</dt><dd className="font-medium capitalize text-foreground">{selectedTemplate.value === "kasiai" ? "Managed by KasiTek" : tone}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Channel</dt><dd className="font-medium text-foreground">Platform chat</dd></div></dl><p className="text-sm text-muted-foreground">This creates a versioned agent, installs it for this workspace, and keeps its run history in the Agent Platform.</p></div> : null}
        {step === "success" ? <div className="mt-8 rounded-xl border border-accent/30 bg-accent/10 p-6 text-center"><Check className="mx-auto h-8 w-8 text-accent" /><h3 className="mt-3 text-lg font-semibold text-foreground">Agent installed</h3><p className="mt-1 text-sm text-muted-foreground">The agent is ready in your workspace and can be opened from Agents.</p></div> : null}
        {error ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          {step === "success" ? <Button type="button" onClick={onInstalled}>Done</Button> : <>
            <Button type="button" variant="outline" onClick={step === "select" ? onClose : () => setStep(step === "review" ? "configure" : "select")}>{step === "select" ? "Close" : "Back"}</Button>
            {step === "configure" ? <Button type="button" disabled={!selectedTemplate?.available} onClick={() => setStep("review")}>Review</Button> : null}
            {step === "review" ? <Button type="button" disabled={!selectedTemplate?.available || loading} onClick={() => void install()}>{loading ? "Installing…" : "Install agent"}</Button> : null}
          </>}
        </div>
      </div>
    </div>
  );
}
