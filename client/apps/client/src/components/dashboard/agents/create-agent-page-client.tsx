"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe2,
  LoaderCircle,
  PlugZap,
  SlidersHorizontal,
  Upload,
  Workflow,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createAgent,
  createAgentInstallation,
  createAgentKnowledgeSource,
  createAgentVersion,
  ingestAgentKnowledgeSourceFile,
  ingestAgentKnowledgeSourceText,
  publishAgentVersion,
  type AgentDefinition,
  type AgentTemplate,
  type AgentVersion,
} from "@/lib/agent-platform";
import { AgentWorkflowEditor, starterGraph, type WorkflowGraphValue } from "./agent-workflow-editor";
import {
  AgentRuntimeLimits,
  defaultAgentRuntimeLimits,
  parseAgentRuntimeLimits,
  type AgentRuntimeLimitsValue,
} from "./agent-runtime-limits";

type Step = 1 | 2 | 3 | 4 | 5;
type KnowledgeRetry = { sourceId: string; kind: "text" | "file"; label: string };

const starterInstructions =
  "You are a helpful user-created assistant. Use only the instructions, knowledge, and integrations configured for this agent. Be clear about what you know, what you did, and what still requires the user to act.";
const runtimeLimitKeys: Array<keyof AgentRuntimeLimitsValue> = [
  "maxIterations",
  "maxToolCalls",
  "maxModelCalls",
  "maxTotalTokens",
  "maxContextMessages",
  "maxContextTokens",
  "maxWallTimeMs",
];
const steps: Array<[Step, string]> = [
  [1, "Basics"],
  [2, "Resources"],
  [3, "Knowledge"],
  [4, "Workflow"],
  [5, "Review"],
];

function initialTemplateRuntimeLimits(template?: AgentTemplate): AgentRuntimeLimitsValue {
  const configuration = template?.configuration ?? {};
  return runtimeLimitKeys.reduce(
    (limits, key) => {
      const value = configuration[key];
      return {
        ...limits,
        [key]:
          typeof value === "number" || typeof value === "string"
            ? String(value)
            : defaultAgentRuntimeLimits[key],
      };
    },
    { ...defaultAgentRuntimeLimits },
  );
}

function templateConfigurationString(template: AgentTemplate | undefined, key: string, fallback: string): string {
  const value = template?.configuration?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function Progress({ step }: { step: Step }) {
  return (
    <nav aria-label="Creation progress" className="mx-auto max-w-3xl">
      <ol className="flex items-start">
        {steps.map(([number, label], index) => (
          <li key={number} className="flex min-w-0 flex-1 items-start">
            <div className="flex min-w-16 flex-col items-center gap-2">
              <span
                aria-current={step === number ? "step" : undefined}
                className={`grid h-9 w-9 place-items-center rounded-full border text-sm font-semibold transition-colors ${
                  step === number
                    ? "border-primary bg-primary text-primary-foreground"
                    : step > number
                      ? "border-status-success bg-status-success text-white"
                      : "border-border bg-secondary text-muted-foreground"
                }`}
              >
                {step > number ? <CheckCircle2 className="h-4 w-4" /> : number}
              </span>
              <span
                className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${
                  step === number
                    ? "text-primary"
                    : step > number
                      ? "text-status-success"
                      : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </div>
            {index < steps.length - 1 ? (
              <span
                className={`mt-[18px] h-px flex-1 ${step > number ? "bg-status-success/60" : "bg-border"}`}
                aria-hidden="true"
              />
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium text-foreground">
      {label}
      {hint ? <span className="ml-1 font-normal text-muted-foreground">{hint}</span> : null}
      {children}
    </label>
  );
}

export function CreateAgentPageClient({ initialTemplate, initialDraft }: { initialTemplate?: AgentTemplate; initialDraft?: { agent: AgentDefinition; version: AgentVersion } }) {
  const router = useRouter();
  const initialDraftConfiguration = initialDraft?.version.configuration ?? {};
  const initialDraftPolicy = initialDraft?.version.policy?.modelPolicy;
  const initialDraftPrimary = initialDraftPolicy && typeof initialDraftPolicy === "object" ? (initialDraftPolicy as Record<string, unknown>).primary : undefined;
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState(initialDraft?.agent.name ?? initialTemplate?.name ?? "");
  const [purpose, setPurpose] = useState(initialDraft?.agent.description ?? initialTemplate?.description ?? "");
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [instructions, setInstructions] = useState(initialDraft?.version.instructions ?? initialTemplate?.instructions ?? starterInstructions);
  const [provider, setProvider] = useState(() => typeof initialDraftConfiguration.provider === "string" ? initialDraftConfiguration.provider : templateConfigurationString(initialTemplate, "provider", "openrouter"));
  const [model, setModel] = useState(() => { const primary = initialDraftPrimary && typeof initialDraftPrimary === "object" ? initialDraftPrimary as Record<string, unknown> : undefined; return typeof primary?.model === "string" ? primary.model : typeof initialDraftConfiguration.model === "string" ? initialDraftConfiguration.model : templateConfigurationString(initialTemplate, "model", "openai/gpt-oss-20b:free"); });
  const [runtimeLimits, setRuntimeLimits] = useState<AgentRuntimeLimitsValue>(() => initialDraft ? {
    maxIterations: String(initialDraftConfiguration.maxIterations ?? defaultAgentRuntimeLimits.maxIterations),
    maxToolCalls: String(initialDraftConfiguration.maxToolCalls ?? defaultAgentRuntimeLimits.maxToolCalls),
    maxModelCalls: String(initialDraftConfiguration.maxModelCalls ?? defaultAgentRuntimeLimits.maxModelCalls),
    maxTotalTokens: String(initialDraftConfiguration.maxTotalTokens ?? defaultAgentRuntimeLimits.maxTotalTokens),
    maxContextMessages: String(initialDraftConfiguration.maxContextMessages ?? defaultAgentRuntimeLimits.maxContextMessages),
    maxContextTokens: String(initialDraftConfiguration.maxContextTokens ?? defaultAgentRuntimeLimits.maxContextTokens),
    maxWallTimeMs: String(initialDraftConfiguration.maxWallTimeMs ?? defaultAgentRuntimeLimits.maxWallTimeMs),
  } : initialTemplateRuntimeLimits(initialTemplate));
  const [workflow, setWorkflow] = useState<WorkflowGraphValue | null>((initialDraftConfiguration.workflow as WorkflowGraphValue | undefined) ?? (initialDraft ? starterGraph : null));
  const [workflowValid, setWorkflowValid] = useState(Boolean(initialDraft));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [publishStage, setPublishStage] = useState<"idle" | "publishing" | "indexing-text" | "indexing-file">("idle");
  const [retryingKnowledge, setRetryingKnowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ agent: AgentDefinition; version: AgentVersion } | null>(initialDraft ?? null);
  const [created, setCreated] = useState<{ id: string; name: string; knowledgeWarning?: string; knowledgeRetries: KnowledgeRetry[] } | null>(null);

  const canContinue =
    step === 1
      ? name.trim().length > 0 && purpose.trim().length > 0
      : step === 4
        ? Boolean(workflow && workflowValid)
        : true;

  const goNext = () => {
    if (!canContinue || step === 5) return;
    setError(null);
    setStep((current) => (current + 1) as Step);
  };

  const goBack = () => {
    if (loading) return;
    setError(null);
    if (step === 1) {
      router.push("/agents");
      return;
    }
    setStep((current) => (current - 1) as Step);
  };

  const submit = async () => {
    if (!name.trim() || !purpose.trim() || loading || draft) return;
    setLoading(true);
    setError(null);
    try {
      const agent = await createAgent({ name: name.trim(), description: purpose.trim(), creationProfile: "custom" });
      const parsedLimits = parseAgentRuntimeLimits(runtimeLimits);
      const blueprint = initialTemplate
        ? {
            key: initialTemplate.key,
            version: initialTemplate.version,
            category: initialTemplate.category,
            requiredConnections: initialTemplate.requiredConnections,
            requiredCapabilities: initialTemplate.requiredCapabilities,
            setupSteps: initialTemplate.setupSteps,
          }
        : undefined;
      const generatedInstructions = [
        `You are a helpful user-created assistant named "${name.trim()}".`,
        `Your purpose is: ${purpose.trim()}`,
        "Use only the instructions, knowledge, and integrations configured for this agent. Do not claim to be KasiAi or a KasiTek workspace assistant.",
        "Be clear about what you know, what you did, and what still requires the user to act.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const version = await createAgentVersion(agent.id, {
        instructions: instructions.trim() === starterInstructions ? generatedInstructions : instructions.trim(),
        configuration: {
          ...(initialTemplate?.configuration ?? {}),
          ...(blueprint ? { blueprint } : {}),
          provider,
          model: model.trim(),
          ...parsedLimits,
          workflow: workflow ?? starterGraph,
        },
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
      setInstructions(instructions.trim() === starterInstructions ? generatedInstructions : instructions.trim());
      setWorkflow(workflow ?? starterGraph);
      setDraft({ agent, version });
      router.replace(`/agents/new?draft=${encodeURIComponent(agent.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create agent draft");
    } finally {
      setLoading(false);
    }
  };

  const createWorkspaceVersion = async (): Promise<AgentVersion | null> => {
    if (!draft || !workflow || !workflowValid) return null;
    const parsedLimits = parseAgentRuntimeLimits(runtimeLimits);
    return createAgentVersion(draft.agent.id, {
      instructions: instructions.trim(),
      configuration: {
        ...(draft.version.configuration ?? {}),
        provider,
        model: model.trim(),
        ...parsedLimits,
        workflow,
      },
      policy: {
        ...(draft.version.policy ?? {}),
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
  };

  const saveWorkspaceDraft = async () => {
    if (!draft || loading) return;
    setLoading(true);
    setError(null);
    try {
      const version = await createWorkspaceVersion();
      if (version) setDraft((current) => current ? { ...current, version } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the agent draft");
    } finally {
      setLoading(false);
    }
  };

  const publishDraft = async () => {
    if (!draft || loading) return;
    setLoading(true);
    setError(null);
    setPublishStage("publishing");
    try {
      const currentVersion = await createWorkspaceVersion();
      const versionToPublish = currentVersion ?? draft.version;
      if (currentVersion) setDraft((current) => current ? { ...current, version: currentVersion } : current);
      const published = await publishAgentVersion(draft.agent.id, versionToPublish.id);
      const installation = await createAgentInstallation(published.id, { profile: "custom", tone: "balanced", responseDetail: "standard" });
      const knowledgeErrors: string[] = [];
      const knowledgeRetries: KnowledgeRetry[] = [];
      if (knowledgeText.trim()) {
        setPublishStage("indexing-text");
        let sourceId: string | null = null;
        try {
          const source = await createAgentKnowledgeSource({ agentId: draft.agent.id, installationId: installation.id, name: "Information encyclopedia", sourceType: "manual" });
          sourceId = source.id;
          await ingestAgentKnowledgeSourceText(source.id, knowledgeText.trim());
        } catch (cause) {
          knowledgeErrors.push(`Pasted information: ${cause instanceof Error ? cause.message : "could not be indexed"}`);
          if (sourceId) knowledgeRetries.push({ sourceId, kind: "text", label: "Pasted information" });
        }
      }
      if (knowledgeFile) {
        setPublishStage("indexing-file");
        let sourceId: string | null = null;
        try {
          const source = await createAgentKnowledgeSource({ agentId: draft.agent.id, installationId: installation.id, name: "Information upload", sourceType: "upload" });
          sourceId = source.id;
          await ingestAgentKnowledgeSourceFile(source.id, knowledgeFile);
        } catch (cause) {
          knowledgeErrors.push(`File upload: ${cause instanceof Error ? cause.message : "could not be indexed"}`);
          if (sourceId) knowledgeRetries.push({ sourceId, kind: "file", label: knowledgeFile.name });
        }
      }
      setCreated({ id: draft.agent.id, name: draft.agent.name, knowledgeWarning: knowledgeErrors.length ? knowledgeErrors.join(" ") : undefined, knowledgeRetries });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to publish and install the custom agent");
    } finally {
      setPublishStage("idle");
      setLoading(false);
    }
  };

  const retryKnowledge = async () => {
    if (!created || !created.knowledgeRetries.length || retryingKnowledge) return;
    setRetryingKnowledge(true);
    const remaining: KnowledgeRetry[] = [];
    const errors: string[] = [];
    for (const retry of created.knowledgeRetries) {
      try {
        if (retry.kind === "text") await ingestAgentKnowledgeSourceText(retry.sourceId, knowledgeText.trim());
        else if (knowledgeFile) await ingestAgentKnowledgeSourceFile(retry.sourceId, knowledgeFile);
        else throw new Error("The original file is no longer available in this form");
      } catch (cause) {
        remaining.push(retry);
        errors.push(`${retry.label}: ${cause instanceof Error ? cause.message : "could not be indexed"}`);
      }
    }
    setCreated({ ...created, knowledgeRetries: remaining, knowledgeWarning: errors.length ? errors.join(" ") : undefined });
    setRetryingKnowledge(false);
  };

  const publishStageLabel = publishStage === "publishing"
    ? "Publishing the reviewed version…"
    : publishStage === "indexing-text"
      ? "Indexing pasted information…"
      : publishStage === "indexing-file"
        ? "Indexing the uploaded file…"
        : null;

  if (created) {
    return (
      <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8"><div className="mx-auto max-w-3xl">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
        <Card className="mt-8 rounded-3xl border-border/80 shadow-xl shadow-black/10"><CardContent className="p-8 text-center sm:p-12">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-status-success-soft text-status-success"><CheckCircle2 className="h-7 w-7" /></div>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-status-success">Agent created</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{created.name} is ready</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">Your custom agent is installed with an isolated text gateway. Add connections and channels from its details page.</p>
          {created.knowledgeWarning ? <div className="mx-auto mt-4 max-w-xl rounded-xl border border-status-attention/30 bg-status-attention-soft p-4 text-left text-sm text-status-attention"><p>The agent was created, but some knowledge was not indexed: {created.knowledgeWarning}</p>{created.knowledgeRetries.length ? <Button type="button" variant="outline" size="sm" className="mt-3" disabled={retryingKnowledge} onClick={() => void retryKnowledge()}>{retryingKnowledge ? "Retrying…" : "Retry indexing"}</Button> : null}</div> : knowledgeText.trim() || knowledgeFile ? <p className="mx-auto mt-4 text-sm text-status-success">Knowledge added and ready for the agent.</p> : null}
          <div className="mt-8 flex flex-wrap justify-center gap-2"><Button type="button" variant="outline" onClick={() => router.push("/agents")}>All agents</Button><Button asChild><Link href={`/agents/${encodeURIComponent(created.id)}`}>Open agent</Link></Button></div>
        </CardContent></Card>
      </div></div>
    );
  }

  if (draft) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-4 sm:px-6 lg:px-8">
        <header className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3"><Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Agents</Link><span className="text-border">/</span><div><div className="flex items-center gap-2"><h1 className="text-lg font-semibold text-foreground">{draft.agent.name}</h1><Badge className="border-status-attention/30 bg-status-attention-soft text-status-attention">Draft</Badge></div><p className="text-xs text-muted-foreground">Build the agent on the canvas</p></div></div>
          <div className="flex items-center gap-2"><span className="hidden text-xs text-muted-foreground sm:inline">v{draft.version.version_number} · not published</span><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void saveWorkspaceDraft()}>{loading && publishStage === "idle" ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{loading && publishStage === "idle" ? "Saving…" : "Save draft"}</Button><Button type="button" size="sm" disabled={loading || !workflow || !workflowValid} onClick={() => void publishDraft()}>{loading && publishStage !== "idle" ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{loading ? publishStageLabel ?? "Publishing…" : "Publish"}</Button></div>
        </header>
        <main className="mx-auto mt-4 max-w-[1440px]">
          {error ? <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
          {publishStageLabel ? <p className="mb-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary" role="status"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />{publishStageLabel}</p> : null}
          <AgentWorkflowEditor configuration={draft.version.configuration ?? {}} onChange={setWorkflow} onValidityChange={setWorkflowValid} knowledgeText={knowledgeText} knowledgeFile={knowledgeFile} onKnowledgeTextChange={setKnowledgeText} onKnowledgeFileChange={(file) => { if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); return; } setError(null); setKnowledgeFile(file); }} />
        </main>
      </div>
    );
  }

  if (!draft && !created) {
    return (
      <div className="min-h-[100dvh] px-4 py-8 sm:px-6 lg:px-8"><div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between gap-4"><Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link><p className="text-xs font-medium text-muted-foreground">New custom agent</p></div>
        <Card className="mt-12 rounded-3xl border-border/80 shadow-xl shadow-black/10"><CardContent className="p-6 sm:p-10 lg:p-12"><div className="text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"><Bot className="h-7 w-7" /></div><h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">Create your agent</h1><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">Give it a name and a job. You’ll configure the rest on the canvas.</p></div>{initialTemplate ? <div className="mt-8 rounded-2xl border border-primary/25 bg-primary/5 p-4"><p className="text-sm font-semibold text-foreground">Starting from {initialTemplate.name}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{initialTemplate.description}</p></div> : null}<div className="mt-8 space-y-5"><Field label="Agent name"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Support operations agent" className="mt-2 h-12 px-4 text-base" /></Field><Field label="What should it do?"><Textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={5} maxLength={2000} placeholder="Handle support questions and guide customers to the right next step." className="mt-2 resize-y px-4 py-3 leading-6" /></Field></div>{error ? <p className="mt-5 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}<div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-6"><Button type="button" variant="outline" disabled={loading} onClick={() => router.push("/agents")}>Cancel</Button><Button type="button" disabled={loading || !name.trim() || !purpose.trim()} onClick={() => void submit()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating draft…</> : "Continue"}</Button></div></CardContent></Card>
      </div></div>
    );
  }

  const stepTitle = step === 1 ? "Define your agent" : step === 2 ? "Choose what it can use" : step === 3 ? "Add its knowledge" : step === 4 ? "Shape the workflow" : "Review your agent";
  const stepDescription = step === 1 ? "Name it and describe its job." : step === 2 ? "Start with no tools. Add services after the baseline works." : step === 3 ? "Optional: paste or upload the information it should use." : step === 4 ? "Connect steps visually. Start with the baseline and add services when needed." : "Review the setup before publishing.";

  return (
    <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8"><div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4"><Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</Link><p className="text-xs font-medium text-muted-foreground">Build a custom agent</p></div>
      <div className="mt-8"><Progress step={step} /></div>
      <Card className="mt-10 rounded-3xl border-border/80 shadow-xl shadow-black/10"><CardContent className="p-6 sm:p-10 lg:p-14"><div className="mx-auto max-w-3xl">
        <div className="text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">{step === 2 ? <PlugZap className="h-7 w-7" /> : step === 3 ? <BookOpen className="h-7 w-7" /> : step === 4 ? <Workflow className="h-7 w-7" /> : step === 5 ? <SlidersHorizontal className="h-7 w-7" /> : <Bot className="h-7 w-7" />}</div><h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">{stepTitle}</h1><p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{stepDescription}</p></div>
        {initialTemplate ? <div className="mt-8 rounded-2xl border border-primary/25 bg-primary/5 p-5"><div className="flex flex-wrap items-center gap-2"><Badge className="border-primary/20 bg-primary/10 text-primary">Custom blueprint</Badge><span className="font-medium text-foreground">{initialTemplate.name}</span></div><p className="mt-2 text-sm leading-6 text-muted-foreground">{initialTemplate.description}</p><div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full border border-border bg-background/60 px-2.5 py-1">{initialTemplate.requiredConnections.length ? `${initialTemplate.requiredConnections.length} connection${initialTemplate.requiredConnections.length === 1 ? "" : "s"} required` : "No connection required"}</span><span className="rounded-full border border-border bg-background/60 px-2.5 py-1">{initialTemplate.setupSteps.length} setup step{initialTemplate.setupSteps.length === 1 ? "" : "s"}</span></div></div> : null}
        <div className="mt-9 space-y-6">
          {step === 1 ? <div className="space-y-5"><Field label="Agent name"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Support operations agent" className="mt-2 h-12 px-4 text-base" /></Field><Field label="What should it help with?"><Textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={5} maxLength={2000} placeholder="Handle support questions and guide customers to the right next step." className="mt-2 resize-y px-4 py-3 leading-6" /></Field></div> : null}
          {step === 2 ? <div className="space-y-4"><Card className="rounded-2xl border-border bg-secondary/20"><CardContent className="space-y-4 p-5"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-status-success-soft text-status-success"><CheckCircle2 className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Text gateway ready</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">The agent will start with an isolated text conversation. No credentials or external services are needed to create it.</p></div><Badge className="ml-auto border-status-success/30 bg-status-success-soft text-status-success">Ready</Badge></div></CardContent></Card><Card className="rounded-2xl border-border"><CardContent className="space-y-4 p-5"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground"><PlugZap className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">External tools</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">No integrations are selected. After the agent is working, connect Email, Calendar, CRM, MCP, REST, or other services from its details page.</p></div><Badge className="ml-auto border-border bg-secondary text-muted-foreground">Not selected</Badge></div>{initialTemplate?.requiredConnections.length ? <div className="rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-sm text-status-attention"><p className="font-medium">This blueprint may need later setup</p><p className="mt-1">{initialTemplate.requiredConnections.join(", ")}</p></div> : null}</CardContent></Card><p className="text-xs leading-5 text-muted-foreground">Connections and capabilities are installation-scoped. Keeping them optional here lets you test the baseline before granting access.</p></div> : null}
          {step === 3 ? <div className="space-y-4"><Card className="rounded-2xl border-border bg-secondary/20"><CardContent className="space-y-4 p-5"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Paste information</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Add the facts, FAQs, policies, or service details this agent should know.</p></div></div><Textarea autoFocus value={knowledgeText} onChange={(event) => setKnowledgeText(event.target.value)} rows={9} maxLength={200_000} placeholder="Paste information here…" className="mt-2 resize-y px-4 py-3 leading-6" /><div className="flex items-center gap-2 text-xs text-muted-foreground"><BookOpen className="h-4 w-4 shrink-0 text-primary" />Optional. You can add more information later.</div></CardContent></Card><label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-secondary/10 p-4 transition-colors hover:border-primary/50 hover:bg-secondary/20"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-5 w-5" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">Upload a file</p><p className="mt-1 truncate text-xs text-muted-foreground">{knowledgeFile ? knowledgeFile.name : "TXT, Markdown, CSV, PDF, DOCX, or Excel · up to 20 MB"}</p></div><input type="file" className="sr-only" accept=".txt,.text,.md,.markdown,.csv,.pdf,.docx,.xlsx,.xls,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); setKnowledgeFile(null); return; } setError(null); setKnowledgeFile(file); }} /></label><div className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-secondary/10 p-4 opacity-60"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground"><Globe2 className="h-4 w-4" /></div><div><p className="text-sm font-medium text-foreground">Website crawling</p><p className="mt-1 text-xs text-muted-foreground">Unavailable</p></div><span className="ml-auto rounded-full border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Unavailable</span></div></div> : null}
          {step === 4 ? <div className="space-y-4"><div className="rounded-2xl border border-border bg-secondary/20 p-5"><div className="flex items-start gap-3"><Workflow className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><h2 className="font-semibold text-foreground">Baseline workflow</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">The starter graph is already configured. You can keep it as-is or add declarative steps for this process.</p></div></div></div><AgentWorkflowEditor configuration={initialTemplate?.configuration ?? {}} onChange={setWorkflow} onValidityChange={setWorkflowValid} /></div> : null}
          {step === 5 ? <div className="space-y-4"><dl className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-secondary/20 text-sm"><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Agent</dt><dd className="font-medium text-foreground sm:text-right">{name}</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Purpose</dt><dd className="text-foreground sm:max-w-[70%] sm:text-right">{purpose}</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Knowledge</dt><dd className="font-medium text-foreground sm:text-right">{knowledgeText.trim() && knowledgeFile ? `Pasted information + ${knowledgeFile.name}` : knowledgeText.trim() ? "Pasted information" : knowledgeFile ? knowledgeFile.name : "None yet"}</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Tools</dt><dd className="font-medium text-foreground sm:text-right">None selected</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium text-foreground sm:text-right">{workflow?.nodes.length ?? 0} nodes · {workflow?.edges.length ?? 0} edges</dd></div></dl><details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="rounded-2xl border border-border bg-secondary/10 p-5"><summary className="cursor-pointer list-none text-sm font-semibold text-foreground">Advanced settings <span className="ml-1 font-normal text-muted-foreground">model, instructions, and runtime limits</span></summary><div className="mt-5 space-y-5"><div className="grid gap-3 sm:grid-cols-[0.65fr_1.35fr]"><Field label="Provider"><Select value={provider} onValueChange={setProvider}><SelectTrigger className="mt-2 h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="openrouter">OpenRouter</SelectItem><SelectItem value="openai">OpenAI</SelectItem><SelectItem value="anthropic">Anthropic</SelectItem><SelectItem value="gemini">Gemini</SelectItem></SelectContent></Select></Field><Field label="Model"><Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" className="mt-2 h-10" /></Field></div><Field label="Instructions"><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={7} maxLength={200000} className="mt-2 resize-y font-mono leading-6" /></Field><AgentRuntimeLimits value={runtimeLimits} onChange={setRuntimeLimits} /></div></details></div> : null}
        </div>
        {error ? <p className="mt-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6"><Button type="button" variant="outline" disabled={loading} onClick={goBack}>{step === 1 ? "Cancel" : <><ChevronLeft className="mr-1 h-4 w-4" />Back</>}</Button>{step < 5 ? <Button type="button" disabled={!canContinue || loading} onClick={goNext}>Continue <ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button type="button" disabled={loading || !workflow || !workflowValid} onClick={() => void submit()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating draft…</> : "Create draft"}</Button>}</div>
      </div></CardContent></Card>
    </div></div>
  );
}
