"use client";

import Link from "@/lib/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Bot, Check, CheckCircle2, ChevronLeft, ChevronRight, Expand, FileText, Globe2, LoaderCircle, Upload } from "lucide-react";
import { useRouter } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentCreationDraftKey, clearAgentCreationDraft, readAgentCreationDraft, writeAgentCreationDraft } from "@/lib/agent-creation-drafts";
import { createAgent, createAgentInstallation, createAgentKnowledgeSource, createAgentVersion, getAgentKnowledgeSource, getAgentWebsiteCrawl, ingestAgentKnowledgeSourceFile, ingestAgentKnowledgeSourceText, publishAgentVersion, startAgentWebsiteCrawl } from "@/lib/agent-platform";
import { containsKnowledgePlaceholders, generatedAgentInstructions, getAgentRole, getAgentRoleOptions, knowledgeOutline, type AgentRoleKey } from "./agent-creation-config";
import { isWebsiteCrawlPreview, WebsiteSourcePreviewDialog, type WebsiteCrawlPreview } from "./website-source-preview-dialog";

type Step = 1 | 2 | 3 | 4;
type AgentAudience = "personal" | "customer_service";
type GeneralAgentBrowserDraft = {
  step?: Step;
  name?: string;
  roles?: string[];
  roleSummary?: string;
  knowledgeText?: string;
  websiteUrl?: string;
  knowledgeOutlineInserted?: boolean;
  knowledgeConfirmed?: boolean;
  tone?: string;
  responseDetail?: string;
  websiteCrawl?: WebsiteCrawlPreview;
  crawlAgent?: { id: string; name: string };
};

const model = { provider: "openrouter", name: "openai/gpt-oss-20b" };

export function CreateGeneralAgentPageClient({ audience = "personal", userId, onBackToStart }: { audience?: AgentAudience; userId?: string; onBackToStart?: () => void }) {
  const router = useRouter();
  const draftKey = agentCreationDraftKey("general", audience, userId);
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const defaultRole = getAgentRole(undefined, audience).key;
  const [roles, setRoles] = useState<AgentRoleKey[]>([defaultRole]);
  const [roleSummary, setRoleSummary] = useState("");
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [knowledgeOutlineInserted, setKnowledgeOutlineInserted] = useState(false);
  const [knowledgeConfirmed, setKnowledgeConfirmed] = useState(false);
  const [crawlAgent, setCrawlAgent] = useState<{ id: string; name: string } | null>(null);
  const [websiteCrawl, setWebsiteCrawl] = useState<WebsiteCrawlPreview | null>(null);
  const [websitePreviewOpen, setWebsitePreviewOpen] = useState(false);
  const websitePreviewRef = useRef<string | undefined>(undefined);
  const [crawlingWebsite, setCrawlingWebsite] = useState(false);
  const [tone, setTone] = useState("balanced");
  const [responseDetail, setResponseDetail] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; knowledgeWarning?: string; websiteCrawlStarted?: boolean } | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);

  const role = roles[0] ?? defaultRole;
  const canContinue = step === 1 ? name.trim().length > 0 && roles.length > 0 : true;
  const handleBack = () => {
    if (step === 1) {
      if (onBackToStart) onBackToStart();
      else router.push("/agents");
      return;
    }
    setStep((current) => (current - 1) as Step);
  };
  // Keep the no-code setup focused on roles that work without an external
  // scheduling integration. Booking remains available through templates or
  // the custom builder once a calendar capability is configured.
  const roleOptions = getAgentRoleOptions(audience).filter((option) => option.key !== "booking_assistant");
  const generatedInstructions = generatedAgentInstructions({ name: name.trim() || "user-configured assistant", audience, role, roles, roleSummary, tone, responseDetail });
  const knowledgeReady = Boolean(knowledgeText.trim() || knowledgeFile || websiteCrawl?.sourceId);
  const knowledgeHasPlaceholders = containsKnowledgePlaceholders(knowledgeText) && !knowledgeFile && !websiteCrawl?.sourceId;

  useEffect(() => {
    const saved = readAgentCreationDraft<GeneralAgentBrowserDraft>(draftKey);
    if (saved) {
      const savedRoles = Array.isArray(saved.roles)
        ? saved.roles.filter((value): value is AgentRoleKey => getAgentRoleOptions(audience).some((option) => option.key === value))
        : [];
      const savedStep = typeof saved.step === "number" && saved.step >= 1 && saved.step <= 4 ? saved.step as Step : 1;
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
      setKnowledgeOutlineInserted(saved.knowledgeOutlineInserted === true);
      setKnowledgeConfirmed(saved.knowledgeConfirmed === true);
      setTone(typeof saved.tone === "string" ? saved.tone : "balanced");
      setResponseDetail(typeof saved.responseDetail === "string" ? saved.responseDetail : "standard");
      setDraftRestored(true);
    }
    setDraftHydrated(true);
  }, [audience, defaultRole, draftKey]);

  useEffect(() => {
    if (!draftHydrated || created) return;
    if (!name.trim() && !roleSummary.trim() && !knowledgeText.trim() && !websiteUrl.trim()) {
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
      knowledgeOutlineInserted,
      knowledgeConfirmed,
      tone,
      responseDetail,
      websiteCrawl,
      crawlAgent,
    });
  }, [created, crawlAgent, draftHydrated, draftKey, knowledgeConfirmed, knowledgeOutlineInserted, knowledgeText, name, responseDetail, roleSummary, roles, step, tone, websiteCrawl, websiteUrl]);

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
            // The crawl status is still useful if the preview request races ingestion.
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
        creationProfile: "general",
        agentAudience: audience,
      });
      if (!crawlAgent) setCrawlAgent({ id: agent.id, name: agent.name });
      const started = await startAgentWebsiteCrawl({
        agentId: agent.id,
        name: `${agent.name} website`,
        url: websiteUrl.trim(),
      });
      websitePreviewRef.current = undefined;
      setWebsiteCrawl({ sourceId: started.source.id, crawlId: started.crawlId, status: started.status });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The website crawl could not be started");
    } finally {
      setCrawlingWebsite(false);
    }
  };

  const create = async () => {
    if (!name.trim() || !roles.length || loading) return;
    if (audience === "customer_service" && !knowledgeReady) {
      setError("Add at least one approved knowledge source before creating a customer-service agent.");
      setStep(2);
      return;
    }
    if (knowledgeHasPlaceholders) {
      setError("Replace the bracketed knowledge examples before creating the agent.");
      setStep(2);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const roleSummaryFallback = roles.map((key) => getAgentRole(key, audience).summary).join(" ");
      const agent = crawlAgent ?? await createAgent({ name: name.trim(), description: roleSummary.trim() || roleSummaryFallback, creationProfile: "general", agentAudience: audience });
      // The total budget includes the prompt tokens. Keep it above the
      // generated agent context budget so a normal greeting can reach the
      // model instead of failing before the first response.
      const maxTotalTokens = 12_000;
      const version = await createAgentVersion(agent.id, {
        instructions: generatedInstructions,
        configuration: {
          provider: model.provider,
          model: model.name,
          maxIterations: 6,
          maxToolCalls: 6,
          maxModelCalls: 6,
          maxTotalTokens,
          maxContextMessages: 24,
          maxContextTokens: 8_000,
          maxWallTimeMs: 60_000,
          agentRole: role,
          agentRoles: roles,
          roleSummary: roleSummary.trim() || roleSummaryFallback,
          instructionMode: "generated",
          knowledgeSetup: { requiredForPublish: audience === "customer_service", outlineInserted: knowledgeOutlineInserted, confirmed: knowledgeConfirmed },
        },
        policy: {
          allowedTools: [],
          modelPolicy: {
            version: "hosted-agent-v1",
            primary: { provider: model.provider, model: model.name },
            fallback: [],
            allowUserFundedFallbackToKasiTek: false,
            maxTokensPerRun: maxTotalTokens,
          },
          runLimits: { maxIterations: 6, maxToolCalls: 6, maxModelCalls: 6, maxTotalTokens, maxContextMessages: 24, maxContextTokens: 8_000, maxWallTimeMs: 60_000 },
        },
      });
      const published = await publishAgentVersion(agent.id, version.id);
      const installation = await createAgentInstallation(published.id, { profile: "general", agentAudience: audience, tone, responseDetail });
      const knowledgeErrors: string[] = [];
      if (knowledgeText.trim()) {
        try {
          const source = await createAgentKnowledgeSource({ agentId: agent.id, installationId: installation.id, name: "Information encyclopedia", sourceType: "manual" });
          await ingestAgentKnowledgeSourceText(source.id, knowledgeText.trim());
        } catch (cause) {
          knowledgeErrors.push(cause instanceof Error ? cause.message : "The pasted information could not be indexed");
        }
      }
      if (knowledgeFile) {
        try {
          const source = await createAgentKnowledgeSource({ agentId: agent.id, installationId: installation.id, name: "Information upload", sourceType: "upload" });
          await ingestAgentKnowledgeSourceFile(source.id, knowledgeFile);
        } catch (cause) {
          knowledgeErrors.push(cause instanceof Error ? cause.message : "The selected file could not be indexed");
        }
      }
      let websiteCrawlStarted = false;
      if (websiteUrl.trim() && (!websiteCrawl || ["failed", "cancelled"].includes(websiteCrawl.status))) {
        try {
          await startAgentWebsiteCrawl({ agentId: agent.id, installationId: installation.id, name: `${agent.name} website`, url: websiteUrl.trim() });
          websiteCrawlStarted = true;
        } catch (cause) {
          knowledgeErrors.push(cause instanceof Error ? cause.message : "The website crawl could not be started");
        }
      }
      clearAgentCreationDraft(draftKey);
      setCreated({ id: agent.id, name: agent.name, knowledgeWarning: knowledgeErrors.length ? knowledgeErrors.join(" ") : undefined, websiteCrawlStarted });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the general-purpose agent");
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
          <Card className="mt-8 rounded-3xl border-border/80 shadow-xl shadow-black/10"><CardContent className="p-8 text-center sm:p-12">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-status-success-soft text-status-success"><CheckCircle2 className="h-7 w-7" /></div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-status-success">Agent created</p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{created.name} is ready</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">Your general-purpose agent is installed. You can add more information, capabilities, and channels from its details page.</p>
            {created.knowledgeWarning ? <p className="mx-auto mt-4 max-w-xl rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-left text-sm text-status-attention">The agent was created, but the selected knowledge was not indexed: {created.knowledgeWarning} You can retry it from the agent details page.</p> : created.websiteCrawlStarted ? <p className="mx-auto mt-4 text-sm text-status-success">Website crawl started. The source will update when it finishes.</p> : null}
            <div className="mt-8 flex flex-wrap justify-center gap-2"><Button type="button" variant="outline" onClick={() => router.push("/agents")}>All agents</Button><Button asChild><Link href={`/agents/${encodeURIComponent(created.id)}`}>Open agent</Link></Button></div>
          </CardContent></Card>
        </div>
      </div>
    );
  }

  const steps = [[1, "Basics"], [2, "Knowledge"], [3, "Behavior"], [4, "Review"]] as const;
  const stepTitle = step === 1 ? "Define your agent" : step === 2 ? "Add its knowledge" : step === 3 ? "How should it respond?" : "Review your agent";
  const stepDescription = step === 1
    ? "Give it a public name and choose the work it should handle."
    : step === 2
      ? "Add facts, policies, and approved answers it can rely on."
      : step === 3
        ? "Choose the defaults that feel right for your team."
        : "Everything looks good? You can change these settings later.";

  return (
      <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          {onBackToStart ? <button type="button" onClick={onBackToStart} className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</button> : <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</Link>}
          <div className="flex items-center gap-3"><p className="text-xs font-medium text-muted-foreground">Create a {audience === "customer_service" ? "customer service" : "personal"} agent</p>{draftHydrated ? <span className="text-xs text-muted-foreground">{draftRestored ? "Draft restored" : "Autosave on"}</span> : null}</div>
        </div>

        <nav aria-label="Creation progress" className="mx-auto mt-8 max-w-3xl">
          <ol className="flex items-start">
            {steps.map(([number, label], index) => (
              <li key={number} className="flex min-w-0 flex-1 items-start">
                <div className="flex min-w-16 flex-col items-center gap-2">
                  <span aria-current={step === number ? "step" : undefined} className={`grid h-9 w-9 place-items-center rounded-full border text-sm font-semibold transition-colors ${step === number ? "border-primary bg-primary text-primary-foreground" : step > number ? "border-status-success bg-status-success text-white" : "border-border bg-secondary text-muted-foreground"}`}>{step > number ? <CheckCircle2 className="h-4 w-4" /> : number}</span>
                  <span className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${step === number ? "text-primary" : step > number ? "text-status-success" : "text-muted-foreground"}`}>{label}</span>
                </div>
                {index < steps.length - 1 ? <span className={`mt-[18px] h-px flex-1 ${step > number ? "bg-status-success/60" : "bg-border"}`} aria-hidden="true" /> : null}
              </li>
            ))}
          </ol>
        </nav>

        <Card className="mt-10 rounded-3xl border-border/80 shadow-xl shadow-black/10">
          <CardContent className="p-6 sm:p-10 lg:p-14">
            <div className="mx-auto max-w-2xl">
              <div className="text-center">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"><Bot className="h-7 w-7" /></div>
                <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">{stepTitle}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{stepDescription}</p>
              </div>

              <div className="mt-9 space-y-5">
                {step === 1 ? <>
                  <label className="block text-sm font-medium text-foreground">Agent name<span className="ml-1 font-normal text-muted-foreground">Visible to customers and workspace members.</span><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="My assistant" className="mt-2 h-12 px-4 text-base" /></label>
                  <div>
                    <p className="text-sm font-medium text-foreground">Responsibilities</p>
                    <p className="mt-1 text-sm text-muted-foreground">Select everything this agent should handle.</p>
                    <div className="mt-3 space-y-2">
                      {roleOptions.map((option) => {
                        const selected = roles.includes(option.key);
                        return <button key={option.key} type="button" onClick={() => setRoles((current) => selected ? (current.length === 1 ? current : current.filter((key) => key !== option.key)) : [...current, option.key])} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "border-border bg-secondary/10 hover:border-primary/50"}`} aria-pressed={selected}><span aria-hidden="true" className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 bg-background"}`}>{selected ? <Check className="h-3.5 w-3.5" /> : null}</span><span><span className="font-semibold text-foreground">{option.label}</span><span className="mt-1 block text-sm leading-5 text-muted-foreground">{option.summary}</span></span></button>;
                      })}
                    </div>
                  </div>
                  <label className="block text-sm font-medium text-foreground">Role context<span className="ml-1 font-normal text-muted-foreground">Optional summary</span><Textarea value={roleSummary} onChange={(event) => setRoleSummary(event.target.value)} rows={3} maxLength={500} placeholder={getAgentRole(role, audience).summary} className="mt-2 resize-y px-4 py-3 leading-6" /></label>
                </> : null}
                {step === 2 ? <>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card className="h-full rounded-2xl border-border bg-secondary/20"><CardContent className="flex h-full flex-col p-5 sm:p-6"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Globe2 className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Website source</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Crawl public pages and add their content and links.</p></div></div><div className="mt-6 flex flex-col gap-2 sm:flex-row"><Input type="url" value={websiteUrl} onChange={(event) => { setWebsiteUrl(event.target.value); websitePreviewRef.current = undefined; setWebsiteCrawl(null); setWebsitePreviewOpen(false); setKnowledgeConfirmed(false); }} placeholder="https://example.com" className="h-11" /><Button type="button" variant="outline" className="h-11 shrink-0" disabled={!name.trim() || !websiteUrl.trim() || crawlingWebsite || ["starting", "scraping", "processing"].includes(websiteCrawl?.status ?? "")} onClick={() => void crawlWebsite()}>{crawlingWebsite ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Crawling…</> : websiteCrawl?.status === "completed" ? "Re-crawl" : "Crawl website"}</Button></div><p className="mt-3 text-xs text-muted-foreground">{websiteCrawl?.status === "completed" ? `Website indexed · ${websiteCrawl.pages ?? websiteCrawl.completed ?? 0} pages` : websiteCrawl?.status === "failed" || websiteCrawl?.status === "cancelled" ? "Crawl failed. Check the URL and try again." : websiteCrawl ? `Crawling pages…${websiteCrawl.completed !== undefined && websiteCrawl.total ? ` ${websiteCrawl.completed}/${websiteCrawl.total}` : ""}` : "Crawl now and review the indexed content before publishing."}</p>{websiteCrawl?.preview ? <div className="mt-4 space-y-2"><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">{websiteCrawl.preview}</pre><Button type="button" variant="outline" size="sm" onClick={() => setWebsitePreviewOpen(true)}><Expand className="mr-1.5 h-3.5 w-3.5" />Expand preview</Button></div> : null}</CardContent></Card>
                    <label className="flex min-h-[196px] cursor-pointer flex-col rounded-2xl border border-border bg-secondary/20 p-5 transition-colors hover:border-primary/50 hover:bg-secondary/30 sm:p-6"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-5 w-5" /></div><div><p className="font-semibold text-foreground">Upload a file</p><p className="mt-1 text-xs leading-5 text-muted-foreground">PDF, Word, Excel, CSV, or text.</p></div></div><span className="mt-5 flex flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background/30 px-4 py-6 text-center text-sm text-muted-foreground">{knowledgeFile ? knowledgeFile.name : "Choose a file · up to 20 MB"}</span><input type="file" className="sr-only" accept=".txt,.text,.md,.markdown,.csv,.pdf,.docx,.xlsx,.xls,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); setKnowledgeFile(null); return; } setError(null); setKnowledgeFile(file); setKnowledgeConfirmed(false); }} /></label>
                  </div>
                  <Card className="rounded-2xl border-border bg-secondary/20"><CardContent className="p-5 sm:p-6"><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Paste approved information</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Add facts, FAQs, policies, or service details.</p></div></div><Textarea autoFocus value={knowledgeText} onChange={(event) => { setKnowledgeText(event.target.value); setKnowledgeOutlineInserted(false); setKnowledgeConfirmed(false); }} rows={7} maxLength={200_000} placeholder="Business facts, services, prices, hours, policies, and approved answers…" className="mt-5 resize-y px-4 py-3 leading-6" /><div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span className="flex items-center gap-2"><BookOpen className="h-4 w-4 shrink-0 text-primary" />{audience === "customer_service" ? "Required before creating this agent." : "Optional for personal agents."}</span><Button type="button" variant="outline" size="sm" onClick={() => { setKnowledgeText(knowledgeOutline(audience, roles)); setKnowledgeOutlineInserted(true); setKnowledgeConfirmed(false); }}>Insert outline</Button></div>{knowledgeHasPlaceholders ? <p className="mt-3 rounded-lg border border-status-attention/30 bg-status-attention-soft px-3 py-2 text-xs text-status-attention">Replace the bracketed examples before creating the agent.</p> : null}{audience === "customer_service" ? <label className="mt-3 flex items-start gap-3 rounded-xl border border-border bg-background/40 p-3 text-sm"><Checkbox checked={knowledgeConfirmed} onCheckedChange={(checked) => setKnowledgeConfirmed(checked === true)} /><span className="leading-5 text-foreground">I confirm these sources are current and approved for customer responses.</span></label> : null}</CardContent></Card>
                </> : null}
                {step === 3 ? <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm font-medium text-foreground">Tone<Select value={tone} onValueChange={setTone}><SelectTrigger className="mt-2 h-12 px-4"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="concise">Concise and direct</SelectItem><SelectItem value="balanced">Balanced</SelectItem><SelectItem value="warm">Warm and conversational</SelectItem><SelectItem value="detailed">Detailed and explanatory</SelectItem></SelectContent></Select></label>
                    <label className="block text-sm font-medium text-foreground">Response detail<Select value={responseDetail} onValueChange={setResponseDetail}><SelectTrigger className="mt-2 h-12 px-4"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="short">Short answers</SelectItem><SelectItem value="standard">Standard answers</SelectItem><SelectItem value="thorough">Thorough answers</SelectItem></SelectContent></Select></label>
                  </div>
                  <div className="flex gap-3 rounded-xl border border-border bg-secondary/30 p-4 text-sm leading-6 text-muted-foreground"><Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />Knowledge sources, capabilities, channels, and advanced settings can be added after the agent is created.</div>
                </> : null}
                {step === 4 ? <>
                  <dl className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-secondary/20 text-sm">
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Name</dt><dd className="font-medium text-foreground sm:text-right">{name}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Responsibilities</dt><dd className="text-foreground sm:max-w-[70%] sm:text-right">{roles.map((key) => getAgentRole(key, audience).label).join(", ")}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Knowledge</dt><dd className="font-medium text-foreground sm:max-w-[70%] sm:text-right">{websiteUrl.trim() ? `${knowledgeText.trim() ? "Pasted information + " : ""}${knowledgeFile ? `${knowledgeFile.name} + ` : ""}Website crawl` : knowledgeText.trim() && knowledgeFile ? `Pasted information + ${knowledgeFile.name}` : knowledgeText.trim() ? "Pasted information" : knowledgeFile ? knowledgeFile.name : "None yet"}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Behavior</dt><dd className="font-medium capitalize text-foreground sm:text-right">{tone}, {responseDetail}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Access</dt><dd className="font-medium text-foreground sm:text-right">No tools selected</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium text-foreground sm:text-right">Standard assistant runtime</dd></div>
                  </dl>
                  <div className="rounded-2xl border border-primary/25 bg-primary/5 p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold text-foreground">Generated behavior</h2><p className="mt-1 text-sm text-muted-foreground">Built from the selected role, audience, and response settings.</p></div><span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">Preview</span></div><pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background/70 p-4 text-xs leading-5 text-muted-foreground">{generatedInstructions}</pre></div>
                  {audience === "customer_service" && !knowledgeReady ? <p className="rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-sm text-status-attention">Add approved knowledge before creating this customer-service agent.</p> : null}
                </> : null}
              </div>

              {error ? <p className="mt-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
              <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6"><Button type="button" variant="outline" disabled={loading} onClick={handleBack}>{step === 1 ? "Cancel" : <><ChevronLeft className="mr-1 h-4 w-4" />Back</>}</Button>{step < 4 ? <Button type="button" disabled={!canContinue} onClick={() => setStep((current) => (current + 1) as Step)}>Continue <ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button type="button" disabled={loading} onClick={() => void create()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating…</> : "Create agent"}</Button>}</div>
            </div>
          </CardContent>
        </Card>
      </div>
      <WebsiteSourcePreviewDialog open={websitePreviewOpen} onOpenChange={setWebsitePreviewOpen} url={websiteUrl} pages={websiteCrawl?.pages ?? websiteCrawl?.completed} content={websiteCrawl?.preview ?? ""} />
    </div>
  );
}
