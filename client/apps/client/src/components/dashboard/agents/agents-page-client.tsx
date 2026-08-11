"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, Check, ChevronRight, Info, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentDefinition } from "@/lib/agent-platform";
import { apiUrl } from "@/lib/server-api";

export type AgentListItem = AgentDefinition;

type AgentTemplate = {
  value: string;
  label: string;
  description: string;
  available: boolean;
};

const templates: AgentTemplate[] = [
  {
    value: "kasiai",
    label: "KasiAi platform guide",
    description: "Your default KasiTek guide for finding features, understanding settings, and completing platform tasks.",
    available: true,
  },
  {
    value: "website_agent",
    label: "Website enquiry agent",
    description: "Capture website enquiries, collect useful context, and route the next step.",
    available: false,
  },
  {
    value: "whatsapp_agent",
    label: "WhatsApp enquiry agent",
    description: "Start with inbound questions, qualification, replies, and team handoff.",
    available: false,
  },
  {
    value: "workflow_agent",
    label: "Internal workflow agent",
    description: "Carry out a defined internal process across connected systems and approvals.",
    available: false,
  },
];

function statusClass(status: string) {
  if (status === "active") return "border-accent/30 bg-accent/10 text-accent";
  if (status === "paused") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-border bg-secondary text-muted-foreground";
}

export function AgentsPageClient({
  initialAgents,
  kasiaiInstallationId,
  initialTemplateKey,
}: {
  initialAgents: AgentListItem[];
  kasiaiInstallationId: string | null;
  initialTemplateKey?: string;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(Boolean(initialTemplateKey));

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
            {initialAgents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
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

      {createOpen ? <TemplateDialog onClose={() => setCreateOpen(false)} onInstalled={() => { setCreateOpen(false); router.refresh(); }} initialTemplateKey={initialTemplateKey} /> : null}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentDefinition }) {
  const isKasiAi = agent.slug === "kasiai";
  return (
    <Card>
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
            {agent.protected ? <Badge className="border-primary/20 bg-primary/10 text-primary">System agent</Badge> : null}
            <Badge className={statusClass(agent.status)}>{agent.status}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>Slug: {agent.slug}</span>
          <span>Created {new Date(agent.created_at).toLocaleDateString()}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {isKasiAi ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-accent"><Check className="h-3.5 w-3.5" />Available from the sidebar</span>
          ) : (
            <span className="text-xs text-muted-foreground">Installed through the shared Agent Platform</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TemplateDialog({ onClose, onInstalled, initialTemplateKey }: { onClose: () => void; onInstalled: () => void; initialTemplateKey?: string }) {
  const [selected, setSelected] = useState(initialTemplateKey === "kasiai" ? "kasiai" : "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTemplate = templates.find((template) => template.value === selected);

  const install = async () => {
    if (!selectedTemplate?.available || selected !== "kasiai") return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/agents/kasiai/ensure"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("KasiAi could not be installed");
      onInstalled();
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
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <button
              key={template.value}
              type="button"
              disabled={!template.available}
              onClick={() => setSelected(template.value)}
              className={`rounded-xl border p-4 text-left transition-colors ${selected === template.value ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/40"} ${!template.available ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{template.label}</span><Badge className={template.available ? "border-accent/20 bg-accent/10 text-accent" : "border-border bg-secondary text-muted-foreground"}>{template.available ? "Available" : "Coming soon"}</Badge></div>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">{template.description}</p>
            </button>
          ))}
        </div>
        {error ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          <Button type="button" disabled={!selectedTemplate?.available || loading} onClick={() => void install()}>{loading ? "Installing…" : "Install template"}</Button>
        </div>
      </div>
    </div>
  );
}
