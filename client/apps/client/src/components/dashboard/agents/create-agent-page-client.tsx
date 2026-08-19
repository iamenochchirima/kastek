"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Bot, CheckCircle2, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { createAgent, createAgentInstallation, createAgentVersion, publishAgentVersion, type AgentDefinition, type AgentTemplate, type AgentVersion } from "@/lib/agent-platform";
import { AgentWorkflowEditor, type WorkflowGraphValue } from "./agent-workflow-editor";
import { AgentRuntimeLimits, defaultAgentRuntimeLimits, parseAgentRuntimeLimits, type AgentRuntimeLimitsValue } from "./agent-runtime-limits";

const starterInstructions = "You are a helpful KasiTek workspace agent. Use only the capabilities granted to this installation. Be clear about what you know, what you did, and what still requires the user to act.";

const runtimeLimitKeys: Array<keyof AgentRuntimeLimitsValue> = ["maxIterations", "maxToolCalls", "maxModelCalls", "maxTotalTokens", "maxContextMessages", "maxContextTokens", "maxWallTimeMs"];

function initialTemplateRuntimeLimits(template?: AgentTemplate): AgentRuntimeLimitsValue {
  const configuration = template?.configuration ?? {};
  return runtimeLimitKeys.reduce((limits, key) => {
    const value = configuration[key];
    return { ...limits, [key]: typeof value === "number" || typeof value === "string" ? String(value) : defaultAgentRuntimeLimits[key] };
  }, { ...defaultAgentRuntimeLimits });
}

function templateConfigurationString(template: AgentTemplate | undefined, key: string, fallback: string): string {
  const value = template?.configuration?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function CreateAgentPageClient({ initialTemplate }: { initialTemplate?: AgentTemplate }) {
  const router = useRouter();
  const [name, setName] = useState(initialTemplate?.name ?? "");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState(initialTemplate?.description ?? "");
  const [instructions, setInstructions] = useState(initialTemplate?.instructions ?? starterInstructions);
  const [provider, setProvider] = useState(() => templateConfigurationString(initialTemplate, "provider", "openrouter"));
  const [model, setModel] = useState(() => templateConfigurationString(initialTemplate, "model", "openai/gpt-oss-20b:free"));
  const [runtimeLimits, setRuntimeLimits] = useState<AgentRuntimeLimitsValue>(() => initialTemplateRuntimeLimits(initialTemplate));
  const [workflow, setWorkflow] = useState<WorkflowGraphValue | null>(null);
  const [workflowValid, setWorkflowValid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ agent: AgentDefinition; version: AgentVersion } | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  const submit = async () => {
    if (!name.trim() || !instructions.trim() || loading || draft) return;
    setLoading(true);
    setError(null);
    try {
      const agent = await createAgent({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
        creationProfile: "custom",
      });
      const parsedLimits = parseAgentRuntimeLimits(runtimeLimits);
      const blueprint = initialTemplate ? {
        key: initialTemplate.key,
        version: initialTemplate.version,
        category: initialTemplate.category,
        requiredConnections: initialTemplate.requiredConnections,
        requiredCapabilities: initialTemplate.requiredCapabilities,
        setupSteps: initialTemplate.setupSteps,
      } : undefined;
      const version = await createAgentVersion(agent.id, {
        instructions: instructions.trim(),
        configuration: { ...(initialTemplate?.configuration ?? {}), ...(blueprint ? { blueprint } : {}), provider, model: model.trim(), ...parsedLimits, workflow },
        policy: {
          ...(initialTemplate?.policy ?? {}),
          modelPolicy: {
            version: "hosted-agent-v1",
            primary: { provider, model: model.trim() },
            fallback: [],
            allowUserFundedFallbackToKasiTek: false,
            maxTokensPerRun: parsedLimits.maxTotalTokens,
          },
          runLimits: parsedLimits,
        },
      });
      setDraft({ agent, version });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create agent");
    } finally {
      setLoading(false);
    }
  };

  const publishDraft = async () => {
    if (!draft || loading) return;
    setLoading(true);
    setError(null);
    try {
      const published = await publishAgentVersion(draft.agent.id, draft.version.id);
      await createAgentInstallation(published.id, { profile: "custom", tone: "balanced", responseDetail: "standard" });
      setCreated({ id: draft.agent.id, name: draft.agent.name });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to publish and install the custom agent");
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <div className="min-h-screen p-6 lg:p-8">
        <div className="mx-auto max-w-2xl">
          <Card>
            <CardContent className="p-8 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-accent" />
              <h1 className="mt-4 text-2xl font-semibold text-foreground">{created.name} is ready</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Your custom agent is published and installed. Continue to its details page to configure capabilities, credentials, channels, and tests.</p>
              <div className="mt-6 flex justify-center gap-2">
                <Button type="button" variant="outline" onClick={() => router.push("/agents")}>All agents</Button>
                <Button asChild type="button"><Link href={`/agents/${encodeURIComponent(created.id)}`}>Open agent</Link></Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (draft) {
    return (
      <div className="min-h-screen p-6 lg:p-8">
        <div className="mx-auto max-w-2xl space-y-6">
          <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
          <Card><CardContent className="space-y-5 p-6">
            <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Custom agent draft</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Review before publishing</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">This draft is saved as an immutable version. Publishing will install it for this workspace; no provider effect runs during this step.</p></div>
            <dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm"><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Agent</dt><dd className="font-medium text-foreground">{draft.agent.name}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Version</dt><dd className="font-medium text-foreground">v{draft.version.version_number} · Draft</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium text-foreground">Validated before draft creation</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Access</dt><dd className="max-w-[65%] text-right font-medium text-foreground">Capabilities and connections remain installation-scoped</dd></div></dl>
            {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
            <div className="flex justify-end"><Button type="button" disabled={loading} onClick={() => void publishDraft()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Publishing…</> : "Publish and install"}</Button></div>
          </CardContent></Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Custom agent</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Build a custom agent</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Configure the agent definition, runtime policy, and workflow graph. For a simpler assistant, use the general-purpose setup.</p>
          {initialTemplate ? <div className="mt-4 rounded-xl border border-primary/25 bg-primary/5 p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Starting from custom blueprint</p><p className="mt-1 font-medium text-foreground">{initialTemplate.name}</p><p className="mt-1 text-sm leading-5 text-muted-foreground">The blueprint preloads its instructions, policy, configuration, and workflow-safe defaults. Review the setup requirements before publishing.</p><div className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><div><p className="font-semibold text-foreground">Required capabilities</p><p className="mt-1 text-muted-foreground">{initialTemplate.requiredCapabilities.length ? initialTemplate.requiredCapabilities.join(", ") : "None"}</p></div><div><p className="font-semibold text-foreground">Required connections</p><p className="mt-1 text-muted-foreground">{initialTemplate.requiredConnections.length ? initialTemplate.requiredConnections.join(", ") : "None"}</p></div></div><div className="mt-3"><p className="font-semibold text-foreground">Setup steps</p><ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{initialTemplate.setupSteps.map((step) => <li key={step}>{step}</li>)}</ul></div></div> : null}
        </header>

        <Card>
          <CardContent className="space-y-5 p-6">
            <div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary"><Bot className="h-5 w-5" /></span><div><h2 className="font-semibold text-foreground">Agent identity</h2><p className="mt-1 text-sm text-muted-foreground">Names and descriptions are visible to workspace members.</p></div></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-foreground">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Support operations agent" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
              <label className="text-sm font-medium text-foreground">Slug <span className="font-normal text-muted-foreground">(optional)</span><input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="support-operations" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
            </div>
            <label className="block text-sm font-medium text-foreground">Description <span className="font-normal text-muted-foreground">(optional)</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} placeholder="What this agent helps with" className="mt-2 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
            <div className="rounded-xl border border-border bg-secondary/20 p-4">
              <h2 className="text-sm font-semibold text-foreground">Model policy</h2>
              <p className="mt-1 text-xs text-muted-foreground">The runtime uses this primary target and enforces the token ceiling on every run.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-[0.65fr_1.35fr_0.7fr]">
                <label className="text-xs font-medium text-foreground">Provider<select value={provider} onChange={(event) => setProvider(event.target.value)} className="mt-1 block w-full rounded-lg border border-border bg-background"><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label>
                <label className="text-xs font-medium text-foreground">Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
                <label className="text-xs font-medium text-foreground">Token budget<input value={runtimeLimits.maxTotalTokens} onChange={(event) => setRuntimeLimits((current) => ({ ...current, maxTotalTokens: event.target.value }))} inputMode="numeric" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
              </div>
            </div>
          </CardContent>
        </Card>

        <AgentRuntimeLimits value={runtimeLimits} onChange={setRuntimeLimits} />
        <label className="block text-sm font-medium text-foreground">Instructions<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={8} maxLength={200000} className="mt-2 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm leading-6" /></label>
        <AgentWorkflowEditor configuration={initialTemplate?.configuration ?? {}} onChange={setWorkflow} onValidityChange={setWorkflowValid} />
        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end"><Button type="button" disabled={loading || !name.trim() || !instructions.trim() || !model.trim() || !workflow || !workflowValid} onClick={() => void submit()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating draft…</> : "Create draft"}</Button></div>
      </div>
    </div>
  );
}
