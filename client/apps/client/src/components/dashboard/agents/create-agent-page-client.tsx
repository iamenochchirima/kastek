"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Expand,
  FileText,
  Globe2,
  LoaderCircle,
  ListChecks,
  PlugZap,
  SlidersHorizontal,
  Upload,
  Workflow,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentCreationDraftKey, clearAgentCreationDraft, readAgentCreationDraft, writeAgentCreationDraft } from "@/lib/agent-creation-drafts";
import {
  createAgent,
  createAgentInstallation,
  createAgentKnowledgeSource,
  createAgentVersion,
  getAgentKnowledgeSource,
  getAgentWebsiteCrawl,
  ingestAgentKnowledgeSourceFile,
  ingestAgentKnowledgeSourceText,
  startAgentWebsiteCrawl,
  publishAgentVersion,
  AGENT_MODEL_PROVIDERS,
  AGENT_MODEL_PROVIDER_LABELS,
  type AgentDefinition,
  type AgentTemplate,
  type AgentVersion,
} from "@/lib/agent-platform";
import { AgentWorkflowEditor, starterGraph, type WorkflowGraphValue } from "./agent-workflow-editor";
import { isWebsiteCrawlPreview, WebsiteSourcePreviewDialog, type WebsiteCrawlPreview } from "./website-source-preview-dialog";
import {
  AgentRuntimeLimits,
  defaultAgentRuntimeLimits,
  parseAgentRuntimeLimits,
  type AgentRuntimeLimitsValue,
} from "./agent-runtime-limits";
import {
  containsKnowledgePlaceholders,
  generatedAgentInstructions,
  getAgentRole,
  getAgentRoleOptions,
  knowledgeOutline,
  type AgentRoleKey,
} from "./agent-creation-config";

type Step = 1 | 2 | 3 | 4 | 5;
type KnowledgeRetry = { sourceId: string; kind: "text" | "file"; label: string };
type CustomAgentBrowserDraft = {
  step?: Step;
  name?: string;
  roles?: string[];
  roleSummary?: string;
  knowledgeText?: string;
  websiteUrl?: string;
  instructions?: string;
  knowledgeOutlineInserted?: boolean;
  knowledgeConfirmed?: boolean;
  provider?: string;
  model?: string;
  runtimeLimits?: Partial<AgentRuntimeLimitsValue>;
  workflow?: WorkflowGraphValue;
  advancedOpen?: boolean;
  websiteCrawl?: WebsiteCrawlPreview;
  crawlAgent?: { id: string; name: string };
};

function isWorkflowDraft(value: unknown): value is WorkflowGraphValue {
  if (!value || typeof value !== "object") return false;
  const workflow = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(workflow.nodes) && Array.isArray(workflow.edges);
}

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

type AgentAudience = "personal" | "customer_service";

function CustomerServiceSetup({ template }: { template?: AgentTemplate }) {
  const setupSteps = template?.setupSteps.length
    ? template.setupSteps
    : ["Add approved knowledge", "Connect a customer channel", "Review escalation rules"];
  return (
    <Card className="rounded-2xl border-primary/25 bg-primary/5">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><ListChecks className="h-5 w-5" /></div>
          <div>
            <h2 className="font-semibold text-foreground">Customer-service setup</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Human handoff is enabled for this agent.</p>
          </div>
          <Badge className="ml-auto border-primary/20 bg-primary/10 text-primary">Handoff enabled</Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-background/50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</p><p className="mt-1 text-sm font-medium text-foreground">{template?.channelCompatibility?.join(", ") || "Platform"}</p></div>
          <div className="rounded-xl border border-border bg-background/50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Queue</p><p className="mt-1 text-sm font-medium text-foreground">Agent Conversations</p></div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Setup</p>
          <ol className="mt-2 grid gap-2 text-sm text-foreground sm:grid-cols-3">
            {setupSteps.map((step, index) => <li key={`${step}-${index}`} className="flex items-start gap-2"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span><span>{step}</span></li>)}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

export function CreateAgentPageClient({ audience = "personal", userId, initialTemplate, initialDraft, onBackToStart }: { audience?: AgentAudience; userId?: string; initialTemplate?: AgentTemplate; initialDraft?: { agent: AgentDefinition; version: AgentVersion }; onBackToStart?: () => void }) {
  const router = useRouter();
  const draftKey = agentCreationDraftKey("custom", audience, userId, initialTemplate?.key);
  const initialDraftConfiguration = initialDraft?.version.configuration ?? {};
  const configuredRole = typeof initialDraftConfiguration.agentRole === "string"
    ? initialDraftConfiguration.agentRole
    : typeof initialTemplate?.configuration?.agentRole === "string"
      ? initialTemplate.configuration.agentRole
      : undefined;
  const configuredRolesValue = initialDraftConfiguration.agentRoles ?? initialTemplate?.configuration?.agentRoles;
  const configuredRoles = Array.isArray(configuredRolesValue)
    ? configuredRolesValue.filter((key): key is AgentRoleKey => typeof key === "string" && getAgentRoleOptions(audience).some((option) => option.key === key))
    : [];
  const configuredKnowledgeSetup = initialDraftConfiguration.knowledgeSetup && typeof initialDraftConfiguration.knowledgeSetup === "object"
    ? initialDraftConfiguration.knowledgeSetup as Record<string, unknown>
    : undefined;
  const initialDraftPolicy = initialDraft?.version.policy?.modelPolicy;
  const initialDraftPrimary = initialDraftPolicy && typeof initialDraftPolicy === "object" ? (initialDraftPolicy as Record<string, unknown>).primary : undefined;
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState(initialDraft?.agent.name ?? initialTemplate?.name ?? "");
  const defaultRole = getAgentRole(configuredRole, audience).key;
  const [roles, setRoles] = useState<AgentRoleKey[]>(configuredRoles.length ? configuredRoles : [defaultRole]);
  const [roleSummary, setRoleSummary] = useState(initialDraft?.agent.description ?? "");
  const [knowledgeText, setKnowledgeText] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [instructions, setInstructions] = useState(initialDraft?.version.instructions ?? "");
  const [knowledgeOutlineInserted, setKnowledgeOutlineInserted] = useState(false);
  const [knowledgeConfirmed, setKnowledgeConfirmed] = useState(configuredKnowledgeSetup?.confirmed === true);
  const [crawlAgent, setCrawlAgent] = useState<{ id: string; name: string } | null>(null);
  const [websiteCrawl, setWebsiteCrawl] = useState<WebsiteCrawlPreview | null>(null);
  const [websitePreviewOpen, setWebsitePreviewOpen] = useState(false);
  const websitePreviewRef = useRef<string | undefined>(undefined);
  const [crawlingWebsite, setCrawlingWebsite] = useState(false);
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
  const [publishStage, setPublishStage] = useState<"idle" | "publishing" | "indexing-text" | "indexing-file" | "crawling-website">("idle");
  const [retryingKnowledge, setRetryingKnowledge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ agent: Pick<AgentDefinition, "id" | "name">; version: AgentVersion } | null>(initialDraft ?? null);
  const [created, setCreated] = useState<{ id: string; name: string; knowledgeWarning?: string; knowledgeRetries: KnowledgeRetry[]; websiteCrawlStarted?: boolean } | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  const role = roles[0] ?? defaultRole;
  const roleOptions = getAgentRoleOptions(audience);
  const generatedInstructions = useMemo(() => generatedAgentInstructions({
    name: name.trim() || "user-configured assistant",
    audience,
    role,
    roles,
    roleSummary,
    templateInstructions: initialTemplate?.instructions,
  }), [audience, initialTemplate?.instructions, name, role, roles, roleSummary]);
  const effectiveInstructions = instructions.trim() || generatedInstructions;
  const knowledgeReady = Boolean(knowledgeText.trim() || knowledgeFile || websiteCrawl?.sourceId);
  const knowledgeHasPlaceholders = containsKnowledgePlaceholders(knowledgeText) && !knowledgeFile && !websiteCrawl?.sourceId;
  const readinessIssues = [
    !workflow || !workflowValid ? "Complete the workflow before publishing." : null,
    audience === "customer_service" && !knowledgeReady ? "Add at least one approved knowledge source for a customer-service agent." : null,
    knowledgeHasPlaceholders ? "Replace the bracketed knowledge examples before publishing." : null,
  ].filter((issue): issue is string => Boolean(issue));

  useEffect(() => {
    const saved = readAgentCreationDraft<CustomAgentBrowserDraft>(draftKey);
    if (saved) {
      const savedRoles = Array.isArray(saved.roles)
        ? saved.roles.filter((value): value is AgentRoleKey => getAgentRoleOptions(audience).some((option) => option.key === value))
        : [];
      const savedStep = typeof saved.step === "number" && saved.step >= 1 && saved.step <= 5 ? saved.step as Step : 1;
      setStep(savedStep);
      setName(typeof saved.name === "string" ? saved.name : "");
      setRoles(savedRoles.length ? savedRoles : [defaultRole]);
      setRoleSummary(typeof saved.roleSummary === "string" ? saved.roleSummary : "");
      setKnowledgeText(typeof saved.knowledgeText === "string" ? saved.knowledgeText : "");
      setWebsiteUrl(typeof saved.websiteUrl === "string" ? saved.websiteUrl : "");
      if (isWebsiteCrawlPreview(saved.websiteCrawl)) {
        setWebsiteCrawl(saved.websiteCrawl);
        websitePreviewRef.current = saved.websiteCrawl.preview;
      }
      if (saved.crawlAgent && typeof saved.crawlAgent.id === "string" && typeof saved.crawlAgent.name === "string") {
        setCrawlAgent({ id: saved.crawlAgent.id, name: saved.crawlAgent.name });
      }
      setInstructions(typeof saved.instructions === "string" ? saved.instructions : "");
      setKnowledgeOutlineInserted(saved.knowledgeOutlineInserted === true);
      setKnowledgeConfirmed(saved.knowledgeConfirmed === true);
      if (typeof saved.provider === "string" && AGENT_MODEL_PROVIDERS.includes(saved.provider as typeof AGENT_MODEL_PROVIDERS[number])) setProvider(saved.provider);
      if (typeof saved.model === "string") setModel(saved.model);
      if (saved.runtimeLimits && typeof saved.runtimeLimits === "object") setRuntimeLimits((current) => ({ ...current, ...saved.runtimeLimits }));
      if (isWorkflowDraft(saved.workflow)) {
        setWorkflow(saved.workflow);
        setWorkflowValid(true);
      }
      setAdvancedOpen(saved.advancedOpen === true);
      setDraftRestored(true);
    }
    setDraftHydrated(true);
  }, [audience, defaultRole, draftKey]);

  useEffect(() => {
    if (!draftHydrated || created) return;
    if (!name.trim() && !roleSummary.trim() && !knowledgeText.trim() && !websiteUrl.trim() && !instructions.trim()) {
      clearAgentCreationDraft(draftKey);
      return;
    }
    writeAgentCreationDraft(draftKey, {
      step,
      name,
      roles,
      roleSummary,
      knowledgeText,
      websiteUrl,
      instructions,
      knowledgeOutlineInserted,
      knowledgeConfirmed,
      provider,
      model,
      runtimeLimits,
      workflow,
      advancedOpen,
      websiteCrawl,
      crawlAgent,
    });
  }, [advancedOpen, crawlAgent, created, draftHydrated, draftKey, instructions, knowledgeConfirmed, knowledgeOutlineInserted, knowledgeText, model, name, provider, roleSummary, roles, runtimeLimits, step, websiteCrawl, websiteUrl, workflow]);

  const crawlSourceId = websiteCrawl?.sourceId;
  const crawlStatus = websiteCrawl?.status;

  useEffect(() => {
    if (!crawlSourceId || !["starting", "scraping", "processing"].includes(crawlStatus ?? "")) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await getAgentWebsiteCrawl(crawlSourceId);
        if (cancelled) return;
        let preview = websitePreviewRef.current;
        if (status.status === "completed") {
          try {
            const source = await getAgentKnowledgeSource(crawlSourceId);
            preview = source.text.trim() || undefined;
          } catch {
            // Status can complete just before source ingestion is readable.
          }
        }
        websitePreviewRef.current = preview;
        setWebsiteCrawl({
          sourceId: status.source.id,
          crawlId: status.crawlId,
          status: status.status,
          total: status.total,
          completed: status.completed,
          pages: status.pages,
          preview,
        });
        if (!["completed", "failed", "cancelled"].includes(status.status)) {
          timer = window.setTimeout(() => void poll(), 4_000);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "The website crawl status could not be loaded");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [crawlSourceId, crawlStatus]);

  useEffect(() => {
    if (!websiteCrawl || websiteCrawl.status !== "completed" || websiteCrawl.preview || !websiteCrawl.sourceId) return;
    let cancelled = false;
    void getAgentKnowledgeSource(websiteCrawl.sourceId).then((source) => {
      if (cancelled) return;
      const preview = source.text.trim() || undefined;
      websitePreviewRef.current = preview;
      setWebsiteCrawl((current) => current?.sourceId === websiteCrawl.sourceId ? { ...current, preview } : current);
    }).catch(() => {
      // The saved crawl metadata remains useful if the source is temporarily unavailable.
    });
    return () => { cancelled = true; };
  }, [websiteCrawl]);

  const crawlWebsite = async () => {
    if (!name.trim() || !websiteUrl.trim() || crawlingWebsite) return;
    setCrawlingWebsite(true);
    setError(null);
    try {
      let agent = crawlAgent;
      if (!agent && websiteCrawl?.sourceId) {
        try {
          const existingSource = await getAgentKnowledgeSource(websiteCrawl.sourceId);
          if (existingSource.source.agent_definition_id) {
            agent = { id: existingSource.source.agent_definition_id, name: name.trim() };
          }
        } catch {
          // If the old source is unavailable, create a fresh draft agent below.
        }
      }
      agent ??= await createAgent({
        name: name.trim(),
        description: roleSummary.trim() || getAgentRole(role, audience).summary,
        creationProfile: "custom",
        agentAudience: audience,
      });
      if (!crawlAgent) setCrawlAgent({ id: agent.id, name: agent.name });
      const started = await startAgentWebsiteCrawl({ agentId: agent.id, name: `${agent.name} website`, url: websiteUrl.trim() });
      websitePreviewRef.current = undefined;
      setWebsiteCrawl({ sourceId: started.source.id, crawlId: started.crawlId, status: started.status });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The website crawl could not be started");
    } finally {
      setCrawlingWebsite(false);
    }
  };

  const canContinue =
    step === 1
      ? name.trim().length > 0 && roles.length > 0
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
      if (onBackToStart) onBackToStart();
      else router.push("/agents");
      return;
    }
    setStep((current) => (current - 1) as Step);
  };

  const submit = async () => {
    if (!name.trim() || !roles.length || loading || draft) return;
    setLoading(true);
    setError(null);
    try {
      const roleSummaryFallback = roles.map((key) => getAgentRole(key, audience).summary).join(" ");
      const agent = crawlAgent ?? await createAgent({ name: name.trim(), description: roleSummary.trim() || roleSummaryFallback, creationProfile: "custom", agentAudience: audience });
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
      const version = await createAgentVersion(agent.id, {
        instructions: effectiveInstructions,
        configuration: {
          ...(initialTemplate?.configuration ?? {}),
            ...(blueprint ? { blueprint } : {}),
            agentRole: role,
            agentRoles: roles,
            roleSummary: roleSummary.trim() || roleSummaryFallback,
          instructionMode: instructions.trim() ? "advanced" : "generated",
          knowledgeSetup: {
            requiredForPublish: audience === "customer_service",
            outlineInserted: knowledgeOutlineInserted,
            confirmed: knowledgeConfirmed,
          },
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
      setWorkflow(workflow ?? starterGraph);
      setDraft({ agent, version });
      if (typeof window !== "undefined") window.history.replaceState({}, "", `/agents/new?draft=${encodeURIComponent(agent.id)}`);
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
      instructions: effectiveInstructions,
      configuration: {
        ...(draft.version.configuration ?? {}),
        agentRole: role,
        agentRoles: roles,
        roleSummary: roleSummary.trim() || roles.map((key) => getAgentRole(key, audience).summary).join(" "),
        instructionMode: instructions.trim() ? "advanced" : "generated",
        knowledgeSetup: {
          requiredForPublish: audience === "customer_service",
          outlineInserted: knowledgeOutlineInserted,
          confirmed: knowledgeConfirmed,
        },
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
    if (readinessIssues.length) {
      setError(readinessIssues[0] ?? "Complete the required setup before publishing.");
      return;
    }
    setLoading(true);
    setError(null);
    setPublishStage("publishing");
    try {
      const currentVersion = await createWorkspaceVersion();
      const versionToPublish = currentVersion ?? draft.version;
      if (currentVersion) setDraft((current) => current ? { ...current, version: currentVersion } : current);
      const published = await publishAgentVersion(draft.agent.id, versionToPublish.id);
      const installation = await createAgentInstallation(published.id, { profile: "custom", agentAudience: audience, tone: "balanced", responseDetail: "standard" });
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
      let websiteCrawlStarted = false;
      if (websiteUrl.trim() && (!websiteCrawl || ["failed", "cancelled"].includes(websiteCrawl.status))) {
        setPublishStage("crawling-website");
        try {
          await startAgentWebsiteCrawl({
            agentId: draft.agent.id,
            installationId: installation.id,
            name: `${draft.agent.name} website`,
            url: websiteUrl.trim(),
          });
          websiteCrawlStarted = true;
        } catch (cause) {
          knowledgeErrors.push(`Website: ${cause instanceof Error ? cause.message : "could not start the crawl"}`);
        }
      }
      clearAgentCreationDraft(draftKey);
      setCreated({ id: draft.agent.id, name: draft.agent.name, knowledgeWarning: knowledgeErrors.length ? knowledgeErrors.join(" ") : undefined, knowledgeRetries, websiteCrawlStarted });
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
      : publishStage === "crawling-website"
        ? "Starting the website crawl…"
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
          {created.knowledgeWarning ? <div className="mx-auto mt-4 max-w-xl rounded-xl border border-status-attention/30 bg-status-attention-soft p-4 text-left text-sm text-status-attention"><p>The agent was created, but some knowledge was not indexed: {created.knowledgeWarning}</p>{created.knowledgeRetries.length ? <Button type="button" variant="outline" size="sm" className="mt-3" disabled={retryingKnowledge} onClick={() => void retryKnowledge()}>{retryingKnowledge ? "Retrying…" : "Retry indexing"}</Button> : null}</div> : created.websiteCrawlStarted ? <p className="mx-auto mt-4 text-sm text-status-success">Website crawl started. The knowledge source will update when it finishes.</p> : knowledgeText.trim() || knowledgeFile ? <p className="mx-auto mt-4 text-sm text-status-success">Knowledge added and ready for the agent.</p> : null}
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
          <div className="flex items-center gap-2"><Badge className="border-primary/20 bg-primary/10 text-primary">{audience === "customer_service" ? "Customer service" : "Personal"}</Badge><span className="hidden text-xs text-muted-foreground sm:inline">v{draft.version.version_number} · not published</span><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void saveWorkspaceDraft()}>{loading && publishStage === "idle" ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{loading && publishStage === "idle" ? "Saving…" : "Save draft"}</Button><Button type="button" size="sm" disabled={loading || readinessIssues.length > 0} onClick={() => void publishDraft()}>{loading && publishStage !== "idle" ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{loading ? publishStageLabel ?? "Publishing…" : "Publish"}</Button></div>
        </header>
        <main className="mx-auto mt-4 max-w-[1440px]">
          {error ? <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
          {publishStageLabel ? <p className="mb-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary" role="status"><LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />{publishStageLabel}</p> : null}
          {readinessIssues.length ? <div className="mb-4 rounded-2xl border border-status-attention/30 bg-status-attention-soft p-4"><p className="font-semibold text-status-attention">Complete setup before publishing</p><ul className="mt-2 space-y-1 text-sm text-status-attention">{readinessIssues.map((issue) => <li key={issue}>• {issue}</li>)}</ul>{audience === "customer_service" ? <label className="mt-3 flex items-start gap-3 rounded-xl border border-status-attention/30 bg-background/30 p-3 text-sm"><Checkbox checked={knowledgeConfirmed} onCheckedChange={(checked) => setKnowledgeConfirmed(checked === true)} /><span className="leading-5 text-status-attention">I confirm these sources are current and approved for customer responses.</span></label> : null}</div> : null}
          {audience === "customer_service" ? <div className="mb-4"><CustomerServiceSetup template={initialTemplate} /></div> : null}
          <AgentWorkflowEditor configuration={draft.version.configuration ?? {}} onChange={setWorkflow} onValidityChange={setWorkflowValid} knowledgeText={knowledgeText} knowledgeFile={knowledgeFile} onKnowledgeTextChange={(value) => { setKnowledgeText(value); setKnowledgeConfirmed(false); }} onKnowledgeFileChange={(file) => { if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); return; } setError(null); setKnowledgeFile(file); setKnowledgeConfirmed(false); }} />
        </main>
      </div>
    );
  }

  const stepTitle = step === 1 ? "Define your agent" : step === 2 ? "Choose what it can use" : step === 3 ? "Add its knowledge" : step === 4 ? "Shape the workflow" : "Review your agent";
  const stepDescription = step === 1 ? "Give it a public name and choose the work it should handle." : step === 2 ? "Start with no tools. Add services after the baseline works." : step === 3 ? "Add facts, policies, and approved answers the agent can rely on." : step === 4 ? "Connect steps visually. Start with the baseline and add services when needed." : "Review the setup and resolve any publish requirements.";

  return (
    <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8"><div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4">{onBackToStart ? <button type="button" onClick={onBackToStart} className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</button> : <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</Link>}<div className="flex items-center gap-3"><p className="text-xs font-medium text-muted-foreground">Build a custom agent</p>{draftHydrated ? <span className="text-xs text-muted-foreground">{draftRestored ? "Draft restored" : "Autosave on"}</span> : null}</div></div>
      <div className="mt-8"><Progress step={step} /></div>
      <Card className="mt-10 rounded-3xl border-border/80 shadow-xl shadow-black/10"><CardContent className="p-6 sm:p-10 lg:p-14"><div className="mx-auto max-w-3xl">
        <div className="text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">{step === 2 ? <PlugZap className="h-7 w-7" /> : step === 3 ? <BookOpen className="h-7 w-7" /> : step === 4 ? <Workflow className="h-7 w-7" /> : step === 5 ? <SlidersHorizontal className="h-7 w-7" /> : <Bot className="h-7 w-7" />}</div><h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">{stepTitle}</h1><p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{stepDescription}</p></div>
        {initialTemplate ? <div className="mt-8 rounded-2xl border border-primary/25 bg-primary/5 p-5"><div className="flex flex-wrap items-center gap-2"><Badge className="border-primary/20 bg-primary/10 text-primary">Custom blueprint</Badge><span className="font-medium text-foreground">{initialTemplate.name}</span></div><p className="mt-2 text-sm leading-6 text-muted-foreground">{initialTemplate.description}</p><div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full border border-border bg-background/60 px-2.5 py-1">{initialTemplate.requiredConnections.length ? `${initialTemplate.requiredConnections.length} connection${initialTemplate.requiredConnections.length === 1 ? "" : "s"} required` : "No connection required"}</span><span className="rounded-full border border-border bg-background/60 px-2.5 py-1">{initialTemplate.setupSteps.length} setup step{initialTemplate.setupSteps.length === 1 ? "" : "s"}</span></div></div> : null}
        <div className="mt-9 space-y-6">
          {step === 1 ? <div className="space-y-6"><Field label="Agent name" hint="Visible to customers and workspace members."><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Support operations agent" className="mt-2 h-12 px-4 text-base" /></Field><div><p className="text-sm font-medium text-foreground">Responsibilities</p><p className="mt-1 text-sm text-muted-foreground">Select everything this agent should handle.</p><div className="mt-3 space-y-2">{roleOptions.map((option) => { const selected = roles.includes(option.key); return <button key={option.key} type="button" onClick={() => setRoles((current) => selected ? (current.length === 1 ? current : current.filter((key) => key !== option.key)) : [...current, option.key])} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "border-border bg-secondary/10 hover:border-primary/50"}`} aria-pressed={selected}><span aria-hidden="true" className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 bg-background"}`}>{selected ? <Check className="h-3.5 w-3.5" /> : null}</span><span><span className="font-semibold text-foreground">{option.label}</span><span className="mt-1 block text-sm leading-5 text-muted-foreground">{option.summary}</span></span></button>; })}</div></div><Field label="Role context" hint="Optional. This stays a summary, not the agent's instructions."><Textarea value={roleSummary} onChange={(event) => setRoleSummary(event.target.value)} rows={3} maxLength={500} placeholder={getAgentRole(role, audience).summary} className="mt-2 resize-y px-4 py-3 leading-6" /></Field></div> : null}
          {step === 2 ? <div className="space-y-4"><Card className="rounded-2xl border-border bg-secondary/20"><CardContent className="space-y-4 p-5"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-status-success-soft text-status-success"><CheckCircle2 className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Text gateway ready</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">The agent will start with an isolated text conversation. No credentials or external services are needed to create it.</p></div><Badge className="ml-auto border-status-success/30 bg-status-success-soft text-status-success">Ready</Badge></div></CardContent></Card><Card className="rounded-2xl border-border"><CardContent className="space-y-4 p-5"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground"><PlugZap className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">External tools</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">No integrations are selected. After the agent is working, connect Email, Calendar, CRM, MCP, REST, or other services from its details page.</p></div><Badge className="ml-auto border-border bg-secondary text-muted-foreground">Not selected</Badge></div>{initialTemplate?.requiredConnections.length ? <div className="rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-sm text-status-attention"><p className="font-medium">This blueprint may need later setup</p><p className="mt-1">{initialTemplate.requiredConnections.join(", ")}</p></div> : null}</CardContent></Card><p className="text-xs leading-5 text-muted-foreground">Connections and capabilities are installation-scoped. Keeping them optional here lets you test the baseline before granting access.</p></div> : null}
          {step === 3 ? <div className="space-y-4"><div className="grid gap-4 md:grid-cols-2"><Card className="h-full rounded-2xl border-border bg-secondary/20"><CardContent className="flex h-full flex-col p-5 sm:p-6"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Globe2 className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Website source</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Crawl public pages and add their content and links.</p></div></div><div className="mt-6 flex flex-col gap-2 sm:flex-row"><Input type="url" value={websiteUrl} onChange={(event) => { setWebsiteUrl(event.target.value); websitePreviewRef.current = undefined; setWebsiteCrawl(null); setWebsitePreviewOpen(false); setKnowledgeConfirmed(false); }} placeholder="https://example.com" className="h-11" /><Button type="button" variant="outline" className="h-11 shrink-0" disabled={!name.trim() || !websiteUrl.trim() || crawlingWebsite || ["starting", "scraping", "processing"].includes(websiteCrawl?.status ?? "")} onClick={() => void crawlWebsite()}>{crawlingWebsite ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Crawling…</> : websiteCrawl?.status === "completed" ? "Re-crawl" : "Crawl website"}</Button></div><p className="mt-3 text-xs text-muted-foreground">{websiteCrawl?.status === "completed" ? `Website indexed · ${websiteCrawl.pages ?? websiteCrawl.completed ?? 0} pages` : websiteCrawl?.status === "failed" || websiteCrawl?.status === "cancelled" ? "Crawl failed. Check the URL and try again." : websiteCrawl ? `Crawling pages…${websiteCrawl.completed !== undefined && websiteCrawl.total ? ` ${websiteCrawl.completed}/${websiteCrawl.total}` : ""}` : "Crawl now and review the indexed content before publishing."}</p>{websiteCrawl?.preview ? <div className="mt-4 space-y-2"><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">{websiteCrawl.preview}</pre><Button type="button" variant="outline" size="sm" onClick={() => setWebsitePreviewOpen(true)}><Expand className="mr-1.5 h-3.5 w-3.5" />Expand preview</Button></div> : null}</CardContent></Card><label className="flex min-h-[196px] cursor-pointer flex-col rounded-2xl border border-border bg-secondary/20 p-5 transition-colors hover:border-primary/50 hover:bg-secondary/30 sm:p-6"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-5 w-5" /></div><div><p className="font-semibold text-foreground">Upload a file</p><p className="mt-1 text-xs leading-5 text-muted-foreground">PDF, Word, Excel, CSV, or text.</p></div></div><span className="mt-5 flex flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background/30 px-4 py-6 text-center text-sm text-muted-foreground">{knowledgeFile ? knowledgeFile.name : "Choose a file · up to 20 MB"}</span><input type="file" className="sr-only" accept=".txt,.text,.md,.markdown,.csv,.pdf,.docx,.xlsx,.xls,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); setKnowledgeFile(null); return; } setError(null); setKnowledgeFile(file); setKnowledgeConfirmed(false); }} /></label></div><Card className="rounded-2xl border-border bg-secondary/20"><CardContent className="p-5 sm:p-6"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Paste approved information</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Add facts, FAQs, policies, and escalation rules.</p></div></div><Textarea autoFocus value={knowledgeText} onChange={(event) => { setKnowledgeText(event.target.value); setKnowledgeOutlineInserted(false); setKnowledgeConfirmed(false); }} rows={7} maxLength={200_000} placeholder="Business facts, services, prices, hours, policies, and approved answers…" className="mt-5 resize-y px-4 py-3 leading-6" /><div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span className="flex items-center gap-2"><BookOpen className="h-4 w-4 shrink-0 text-primary" />{audience === "customer_service" ? "Required before publishing." : "Optional for personal agents."}</span><Button type="button" variant="outline" size="sm" onClick={() => { setKnowledgeText(knowledgeOutline(audience, roles)); setKnowledgeOutlineInserted(true); setKnowledgeConfirmed(false); }}>Insert outline</Button></div>{knowledgeHasPlaceholders ? <p className="rounded-lg border border-status-attention/30 bg-status-attention-soft px-3 py-2 text-xs text-status-attention">Replace the bracketed examples before publishing.</p> : null}{audience === "customer_service" ? <label className="mt-3 flex items-start gap-3 rounded-xl border border-border bg-background/40 p-3 text-sm"><Checkbox checked={knowledgeConfirmed} onCheckedChange={(checked) => setKnowledgeConfirmed(checked === true)} /><span className="leading-5 text-foreground">I confirm these sources are current and approved for customer responses.</span></label> : null}</CardContent></Card></div> : null}
          {step === 4 ? <div className="space-y-4"><div className="rounded-2xl border border-border bg-secondary/20 p-5"><div className="flex items-start gap-3"><Workflow className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><h2 className="font-semibold text-foreground">Baseline workflow</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">The starter graph is already configured. You can keep it as-is or add declarative steps for this process.</p></div></div></div><AgentWorkflowEditor configuration={initialTemplate?.configuration ?? {}} onChange={setWorkflow} onValidityChange={setWorkflowValid} /></div> : null}
          {step === 5 ? <div className="space-y-4"><dl className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-secondary/20 text-sm"><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Agent</dt><dd className="font-medium text-foreground sm:text-right">{name}</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Responsibilities</dt><dd className="text-foreground sm:max-w-[70%] sm:text-right">{roles.map((key) => getAgentRole(key, audience).label).join(", ")}</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Knowledge</dt><dd className="font-medium text-foreground sm:text-right">{websiteUrl.trim() ? `${knowledgeText.trim() ? "Pasted information + " : ""}${knowledgeFile ? `${knowledgeFile.name} + ` : ""}Website crawl` : knowledgeText.trim() && knowledgeFile ? `Pasted information + ${knowledgeFile.name}` : knowledgeText.trim() ? "Pasted information" : knowledgeFile ? knowledgeFile.name : "None yet"}</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Tools</dt><dd className="font-medium text-foreground sm:text-right">None selected</dd></div><div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium text-foreground sm:text-right">{workflow?.nodes.length ?? 0} nodes · {workflow?.edges.length ?? 0} edges</dd></div></dl><Card className="rounded-2xl border-primary/25 bg-primary/5"><CardContent className="space-y-3 p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-foreground">Generated behavior</h2><p className="mt-1 text-sm text-muted-foreground">Built from the selected role, audience, and configured knowledge rules.</p></div><Badge className="border-primary/20 bg-primary/10 text-primary">Preview</Badge></div><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background/70 p-4 text-xs leading-5 text-muted-foreground">{effectiveInstructions}</pre></CardContent></Card>{readinessIssues.length ? <div className="rounded-2xl border border-status-attention/30 bg-status-attention-soft p-5"><h2 className="font-semibold text-status-attention">Before publishing</h2><ul className="mt-2 space-y-1 text-sm text-status-attention">{readinessIssues.map((issue) => <li key={issue}>• {issue}</li>)}</ul></div> : <div className="rounded-2xl border border-status-success/30 bg-status-success-soft p-4 text-sm text-status-success">Setup is ready for draft creation.</div>}<details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="rounded-2xl border border-border bg-secondary/10 p-5"><summary className="cursor-pointer list-none text-sm font-semibold text-foreground">Advanced settings <span className="ml-1 font-normal text-muted-foreground">edit behavior, model, and runtime limits</span></summary><div className="mt-5 space-y-5"><div className="grid gap-3 sm:grid-cols-[0.65fr_1.35fr]"><Field label="Provider"><Select value={provider} onValueChange={setProvider}><SelectTrigger className="mt-2 h-10"><SelectValue /></SelectTrigger><SelectContent>{AGENT_MODEL_PROVIDERS.map((providerId) => <SelectItem key={providerId} value={providerId}>{AGENT_MODEL_PROVIDER_LABELS[providerId]}</SelectItem>)}</SelectContent></Select></Field><Field label="Model"><Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" className="mt-2 h-10" /></Field></div><Field label="Advanced instructions" hint="Optional override"><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={7} maxLength={200000} placeholder={generatedInstructions} className="mt-2 resize-y font-mono leading-6" /></Field><AgentRuntimeLimits value={runtimeLimits} onChange={setRuntimeLimits} /></div></details></div> : null}
        </div>
        {error ? <p className="mt-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6"><Button type="button" variant="outline" disabled={loading} onClick={goBack}>{step === 1 ? "Cancel" : <><ChevronLeft className="mr-1 h-4 w-4" />Back</>}</Button>{step < 5 ? <Button type="button" disabled={!canContinue || loading} onClick={goNext}>Continue <ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button type="button" disabled={loading || !workflow || !workflowValid} onClick={() => void submit()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating draft…</> : "Create draft"}</Button>}</div>
      </div></CardContent></Card>
    </div><WebsiteSourcePreviewDialog open={websitePreviewOpen} onOpenChange={setWebsitePreviewOpen} url={websiteUrl} pages={websiteCrawl?.pages ?? websiteCrawl?.completed} content={websiteCrawl?.preview ?? ""} /></div>
  );
}
