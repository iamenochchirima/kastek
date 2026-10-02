"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, Check, ChevronLeft, ChevronRight, LoaderCircle, PlugZap, Rocket, ShieldCheck } from "lucide-react";
import { useRouter } from "@/lib/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AGENT_MODEL_PROVIDER_LABELS,
  AGENT_MODEL_PROVIDERS,
  createAgent,
  createAgentInstallation,
  createAgentKnowledgeSource,
  createAgentVersion,
  getAgentModelCatalog,
  ingestAgentKnowledgeSourceText,
  listAgentCapabilities,
  publishAgentVersion,
  type AgentCapability,
  type AgentDefinition,
  type AgentModelProvider,
  type AgentTemplate,
  type AgentVersion,
} from "@/lib/agent-platform";

type Audience = "personal" | "customer_service";
type Step = 1 | 2 | 3;

const defaultModel = "openai/gpt-oss-20b";

function capabilityLabel(capability: AgentCapability): string {
  return capability.documentation?.title || capability.name;
}

function providerValue(value: string): AgentModelProvider {
  return AGENT_MODEL_PROVIDERS.includes(value as AgentModelProvider)
    ? value as AgentModelProvider
    : "openrouter";
}

function buildInstructions(name: string, audience: Audience, purpose: string): string {
  const audienceLine = audience === "customer_service"
    ? "Answer customer questions from approved knowledge. Say when the available information does not support an answer. Do not claim that an action happened unless a tool result confirms it."
    : "Help the user complete the stated work. Separate known information from assumptions and do not claim that an external action happened unless a tool result confirms it.";
  return `You are ${name || "a KasiTek agent"}. ${purpose.trim() || "Work within the user's stated goal."} ${audienceLine}`;
}

function Progress({ step }: { step: Step }) {
  return (
    <ol className="mx-auto flex max-w-2xl items-start" aria-label="Agent creation progress">
      {(["Profile", "Capabilities", "Review"] as const).map((label, index) => {
        const number = (index + 1) as Step;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-start">
            <div className="flex min-w-20 flex-col items-center gap-2">
              <span className={`grid size-9 place-items-center rounded-full border text-sm font-semibold ${step === number ? "border-primary bg-primary text-primary-foreground" : step > number ? "border-status-success bg-status-success text-white" : "border-border bg-secondary text-muted-foreground"}`}>
                {step > number ? <Check className="size-4" /> : number}
              </span>
              <span className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${step === number ? "text-primary" : step > number ? "text-status-success" : "text-muted-foreground"}`}>{label}</span>
            </div>
            {index < 2 ? <span className={`mt-[18px] h-px flex-1 ${step > number ? "bg-status-success/60" : "bg-border"}`} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function AgentProfileCreationPageClient({
  audience = "personal",
  initialTemplate,
  initialDraft,
  onBackToStart,
}: {
  audience?: Audience;
  userId?: string;
  initialTemplate?: AgentTemplate;
  initialDraft?: { agent: AgentDefinition; version: AgentVersion };
  onBackToStart?: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState(initialDraft?.agent.name ?? initialTemplate?.name ?? "");
  const [purpose, setPurpose] = useState(initialDraft?.agent.description ?? initialTemplate?.description ?? "");
  const [instructions, setInstructions] = useState(initialDraft?.version.instructions ?? initialTemplate?.instructions ?? "");
  const [provider, setProvider] = useState<AgentModelProvider>("openrouter");
  const [model, setModel] = useState(defaultModel);
  const [knowledgeText, setKnowledgeText] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>(initialTemplate?.requiredCapabilities ?? []);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ agent: AgentDefinition; installationId: string; warning?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgentCapabilities(), getAgentModelCatalog()])
      .then(([catalog, models]) => {
        if (cancelled) return;
        setCapabilities(catalog.capabilities);
        const preferred = models.models.find((candidate) => candidate.isWorkspaceDefault) ?? models.models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModel(preferred.model);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load agent capabilities");
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false);
      });
    return () => { cancelled = true; };
  }, []);

  const effectiveInstructions = instructions.trim() || buildInstructions(name, audience, purpose);
  const availableCapabilities = useMemo(() => capabilities.filter((capability) => capability.availability !== "not_configured" && capability.availability !== "unhealthy"), [capabilities]);
  const blockedCapabilities = useMemo(() => capabilities.filter((capability) => !availableCapabilities.includes(capability)), [availableCapabilities, capabilities]);
  const canContinue = step === 1 ? name.trim().length > 0 && purpose.trim().length > 0 : step === 2 ? true : audience !== "customer_service" || knowledgeText.trim().length > 0;

  const toggleTool = (nameToToggle: string) => {
    setSelectedTools((current) => current.includes(nameToToggle) ? current.filter((nameValue) => nameValue !== nameToToggle) : [...current, nameToToggle]);
  };

  const goBack = () => {
    if (loading) return;
    if (step === 1) {
      if (onBackToStart) onBackToStart();
      else router.push("/agents");
      return;
    }
    setError(null);
    setStep((current) => (current - 1) as Step);
  };

  const createPlaygroundAgent = async () => {
    if (!canContinue || loading) return;
    setLoading(true);
    setError(null);
    try {
      const agent = initialDraft?.agent ?? await createAgent({
        name: name.trim(),
        description: purpose.trim(),
        creationProfile: "custom",
        agentAudience: audience,
      });
      const version = await createAgentVersion(agent.id, {
        spec: {
          specVersion: 1,
          identity: { displayName: name.trim(), purpose: purpose.trim(), audience },
          behavior: { instructions: effectiveInstructions },
          model: {
            version: "hosted-agent-v1",
            primary: { provider: providerValue(provider), model: model.trim() },
            fallback: [],
            allowUserFundedFallbackToKasiTek: false,
          },
          runtime: {
            maxContextMessages: 24,
            maxContextTokens: 6_000,
            maxIterations: 8,
            maxModelCalls: 8,
            maxToolCalls: 12,
            maxTotalTokens: 20_000,
            maxWallTimeMs: 120_000,
          },
          capabilities: { allowedTools: selectedTools, requiredCapabilities: [] },
          knowledge: { sourceIds: [], requiredConnections: [] },
          memory: { mode: "explicit" },
          skills: { allowedSkillIds: [] },
          extensions: { packages: [], grants: [] },
          workflow: {},
          channels: { allowed: ["platform"] },
          release: { mode: "pinned" },
        },
      });
      const published = await publishAgentVersion(agent.id, version.id);
      const installation = await createAgentInstallation(published.id, {
        environment: "playground",
        source: "agent_creation",
        profile: "custom",
        agentAudience: audience,
      }, "pinned");

      let warning: string | undefined;
      if (knowledgeText.trim()) {
        try {
          const source = await createAgentKnowledgeSource({
            agentId: agent.id,
            installationId: installation.id,
            name: `${agent.name} approved knowledge`,
            sourceType: "manual",
          });
          await ingestAgentKnowledgeSourceText(source.id, knowledgeText.trim());
        } catch (cause) {
          warning = cause instanceof Error ? cause.message : "Knowledge could not be indexed";
        }
      }
      setCreated({ agent, installationId: installation.id, warning });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the agent");
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <div className="min-h-[100dvh] px-4 py-8 sm:px-6 lg:px-8">
        <Card className="mx-auto max-w-2xl rounded-3xl border-border/80 shadow-xl shadow-black/10">
          <CardContent className="p-8 text-center sm:p-12">
            <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-status-success-soft text-status-success"><Rocket className="size-7" /></div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-status-success">Playground ready</p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{created.agent.name}</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">The pinned version is installed in the Playground environment. Run it before connecting a live channel.</p>
            {created.warning ? <p className="mx-auto mt-4 max-w-lg rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-left text-sm text-status-attention">The agent was created, but knowledge indexing needs attention: {created.warning}</p> : null}
            <div className="mt-8 flex flex-wrap justify-center gap-2">
              <Button type="button" variant="outline" onClick={() => router.push("/agents")}>Agents</Button>
              <Button type="button" onClick={() => router.push(`/studio?agent=${encodeURIComponent(created.agent.id)}`)}>Open Studio</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          <button type="button" onClick={goBack} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Back</button>
          <Badge className="border-primary/20 bg-primary/10 text-primary">{audience === "customer_service" ? "Customer service" : "Personal"} agent</Badge>
        </div>
        <div className="mt-8"><Progress step={step} /></div>
        <Card className="mt-10 rounded-3xl border-border/80 shadow-xl shadow-black/10">
          <CardContent className="p-6 sm:p-10 lg:p-14">
            <div className="mx-auto max-w-3xl">
              <div className="text-center">
                <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"><Bot className="size-7" /></div>
                <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">{step === 1 ? "Define the agent" : step === 2 ? "Choose capabilities" : "Review and start"}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{step === 1 ? "Set the profile and behavior." : step === 2 ? "Grant only the tools this agent should be able to call." : "Create a pinned Playground installation for testing."}</p>
              </div>

              <div className="mt-9 space-y-5">
                {step === 1 ? <div className="space-y-5">
                  <label className="block text-sm font-medium text-foreground">Name<Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer support agent" className="mt-2 h-12 px-4 text-base" /></label>
                  <label className="block text-sm font-medium text-foreground">Purpose<Textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={3} maxLength={2_000} placeholder="Answer customer questions using approved company information." className="mt-2 resize-y px-4 py-3" /></label>
                  <label className="block text-sm font-medium text-foreground">Instructions <span className="font-normal text-muted-foreground">optional</span><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={7} maxLength={200_000} placeholder={buildInstructions(name, audience, purpose)} className="mt-2 resize-y font-mono text-xs leading-5" /></label>
                  <div className="grid gap-3 sm:grid-cols-[0.7fr_1.3fr]">
                    <label className="block text-sm font-medium text-foreground">Provider<Select value={provider} onValueChange={(value) => setProvider(providerValue(value))}><SelectTrigger className="mt-2 h-10"><SelectValue /></SelectTrigger><SelectContent>{AGENT_MODEL_PROVIDERS.map((value) => <SelectItem key={value} value={value}>{AGENT_MODEL_PROVIDER_LABELS[value]}</SelectItem>)}</SelectContent></Select></label>
                    <label className="block text-sm font-medium text-foreground">Model<Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={defaultModel} className="mt-2 h-10" /></label>
                  </div>
                </div> : null}

                {step === 2 ? <div className="space-y-4">
                  <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><PlugZap className="mt-0.5 size-5 shrink-0 text-primary" /><div><p className="text-sm font-medium text-foreground">Capability registry</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Selected capabilities become part of this agent version. Approval and runtime limits still apply.</p></div></div>
                  {loadingCatalog ? <div className="flex items-center gap-2 rounded-xl border border-border p-5 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading capabilities</div> : availableCapabilities.length ? <div className="grid gap-2 sm:grid-cols-2">{availableCapabilities.map((capability) => { const selected = selectedTools.includes(capability.name); return <label key={capability.name} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${selected ? "border-primary bg-primary/10" : "border-border bg-secondary/10 hover:border-primary/50"}`}><Checkbox checked={selected} onCheckedChange={() => toggleTool(capability.name)} /><span className="min-w-0"><span className="block text-sm font-medium text-foreground">{capabilityLabel(capability)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{capability.description}</span><span className="mt-2 block text-[10px] uppercase tracking-wide text-muted-foreground">{capability.riskClass}{capability.requiresApproval ? " · approval" : ""}</span></span></label>; })}</div> : <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">No capabilities are available yet.</p>}
                  {blockedCapabilities.length ? <p className="rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-xs text-status-attention">Some capabilities are not ready and are hidden until their provider or connection is configured.</p> : null}
                  <div className="flex items-start gap-3 rounded-xl border border-border bg-secondary/20 p-4"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /><p className="text-xs leading-5 text-muted-foreground">A selected tool is a version grant. Credentials, connector scope, approvals, and resource access are checked again when the agent runs.</p></div>
                </div> : null}

                {step === 3 ? <div className="space-y-4">
                  <label className="block text-sm font-medium text-foreground">Approved knowledge <span className="font-normal text-muted-foreground">{audience === "customer_service" ? "required" : "optional"}</span><Textarea value={knowledgeText} onChange={(event) => setKnowledgeText(event.target.value)} rows={9} maxLength={200_000} placeholder="Facts, policies, services, prices, hours, and approved answers." className="mt-2 resize-y px-4 py-3" /></label>
                  <dl className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-secondary/20 text-sm"><div className="flex items-center justify-between gap-4 px-4 py-3"><dt className="text-muted-foreground">Agent</dt><dd className="font-medium text-foreground">{name || "Unnamed"}</dd></div><div className="flex items-center justify-between gap-4 px-4 py-3"><dt className="text-muted-foreground">Capabilities</dt><dd className="font-medium text-foreground">{selectedTools.length}</dd></div><div className="flex items-center justify-between gap-4 px-4 py-3"><dt className="text-muted-foreground">Model</dt><dd className="font-medium text-foreground">{provider}/{model || defaultModel}</dd></div><div className="flex items-center justify-between gap-4 px-4 py-3"><dt className="text-muted-foreground">Environment</dt><dd className="font-medium text-primary">Playground</dd></div></dl>
                  {audience === "customer_service" && !knowledgeText.trim() ? <p className="rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-sm text-status-attention">Add approved knowledge before creating a customer-service agent.</p> : null}
                </div> : null}
              </div>

              {error ? <p className="mt-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
              <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6"><Button type="button" variant="outline" disabled={loading} onClick={goBack}>{step === 1 ? "Cancel" : <><ChevronLeft className="mr-1 size-4" />Back</>}</Button>{step < 3 ? <Button type="button" disabled={!canContinue || loading} onClick={() => { setError(null); setStep((current) => (current + 1) as Step); }}>Continue <ChevronRight className="ml-1 size-4" /></Button> : <Button type="button" disabled={!canContinue || loading} onClick={() => void createPlaygroundAgent()}>{loading ? <><LoaderCircle className="mr-2 size-4 animate-spin" />Creating</> : <><Rocket className="mr-2 size-4" />Create Playground agent</>}</Button>}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
