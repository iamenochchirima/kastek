"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, BookOpen, Bot, CheckCircle2, ChevronLeft, ChevronRight, FileText, Globe2, LoaderCircle, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createAgent, createAgentInstallation, createAgentKnowledgeSource, createAgentVersion, ingestAgentKnowledgeSourceFile, ingestAgentKnowledgeSourceText, publishAgentVersion } from "@/lib/agent-platform";

type Step = 1 | 2 | 3 | 4;

const model = { provider: "openrouter", name: "openai/gpt-oss-20b:free" };

export function CreateGeneralAgentPageClient() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [knowledgeText, setKnowledgeText] = useState("");
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [tone, setTone] = useState("balanced");
  const [responseDetail, setResponseDetail] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; knowledgeWarning?: string } | null>(null);

  const canContinue = step === 1
    ? name.trim().length > 0 && purpose.trim().length > 0
    : true;

  const create = async () => {
    if (!name.trim() || !purpose.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const agent = await createAgent({ name: name.trim(), description: purpose.trim(), creationProfile: "general" });
      const maxTotalTokens = 2_048;
      const version = await createAgentVersion(agent.id, {
        instructions: [
          `You are a user-created assistant named "${name.trim()}".`,
          `Your configured purpose is: ${purpose.trim()}`,
          `Use a ${tone} tone and provide ${responseDetail} responses.`,
          "You are not KasiAi and you are not the KasiTek platform guidance agent.",
          "Use the configured knowledge for this agent and trusted tool results when they are available. If the answer is not supported by that knowledge or evidence, say that you do not have that information.",
          "Never substitute generic KasiTek platform guidance, invent facts, pricing, policies, availability, or completed actions, and never claim an action succeeded without a trusted result.",
          "Keep internal capabilities, grounding markers, and execution details out of user-facing responses.",
        ].join("\n\n"),
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
      const installation = await createAgentInstallation(published.id, { profile: "general", tone, responseDetail });
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
      setCreated({ id: agent.id, name: agent.name, knowledgeWarning: knowledgeErrors.length ? knowledgeErrors.join(" ") : undefined });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the general-purpose agent");
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
          <Card className="mt-8 rounded-3xl border-border/80 shadow-xl shadow-black/10"><CardContent className="p-8 text-center sm:p-12">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-status-success-soft text-status-success"><CheckCircle2 className="h-7 w-7" /></div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-status-success">Agent created</p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{created.name} is ready</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">Your general-purpose agent is installed. You can add more information, capabilities, and channels from its details page.</p>
            {created.knowledgeWarning ? <p className="mx-auto mt-4 max-w-xl rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-3 text-left text-sm text-status-attention">The agent was created, but the selected knowledge was not indexed: {created.knowledgeWarning} You can retry it from the agent details page.</p> : null}
            <div className="mt-8 flex flex-wrap justify-center gap-2"><Button type="button" variant="outline" onClick={() => router.push("/agents")}>All agents</Button><Button asChild><Link href={`/agents/${encodeURIComponent(created.id)}`}>Open agent</Link></Button></div>
          </CardContent></Card>
        </div>
      </div>
    );
  }

  const steps = [[1, "Basics"], [2, "Knowledge"], [3, "Behavior"], [4, "Review"]] as const;
  const stepTitle = step === 1 ? "What should we call it?" : step === 2 ? "What should it know?" : step === 3 ? "How should it respond?" : "Review your agent";
  const stepDescription = step === 1
    ? "Give your assistant a clear name and purpose."
    : step === 2
      ? "Add approved information it can use to answer questions. You can skip this and add more later."
      : step === 3
        ? "Choose the defaults that feel right for your team."
        : "Everything looks good? You can change these settings later.";

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</Link>
          <p className="text-xs font-medium text-muted-foreground">Create a general-purpose agent</p>
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
                  <label className="block text-sm font-medium text-foreground">Agent name<Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="My assistant" className="mt-2 h-12 px-4 text-base" /></label>
                  <label className="block text-sm font-medium text-foreground">What should it help with?<Textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={4} maxLength={2000} placeholder="Help my team answer customer questions and find the right next step." className="mt-2 resize-y px-4 py-3 leading-6" /></label>
                </> : null}
                {step === 2 ? <>
                  <div className="rounded-2xl border border-border bg-secondary/20 p-5 sm:p-6">
                    <div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="h-5 w-5" /></div><div><h2 className="font-semibold text-foreground">Paste your information</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Add the facts, FAQs, policies, or service details your agent should know.</p></div></div>
                    <Textarea autoFocus value={knowledgeText} onChange={(event) => setKnowledgeText(event.target.value)} rows={10} maxLength={200_000} placeholder="Paste information here…" className="mt-5 resize-y px-4 py-3 leading-6" />
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><BookOpen className="h-4 w-4 shrink-0 text-primary" />Optional. You can add more information later.</div>
                  </div>
                  <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-secondary/10 p-4 transition-colors hover:border-primary/50 hover:bg-secondary/20"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-5 w-5" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">Upload a file</p><p className="mt-1 truncate text-xs text-muted-foreground">{knowledgeFile ? knowledgeFile.name : "TXT, Markdown, CSV, PDF, DOCX, or Excel · up to 20 MB"}</p></div><input type="file" className="sr-only" accept=".txt,.text,.md,.markdown,.csv,.pdf,.docx,.xlsx,.xls,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); setKnowledgeFile(null); return; } setError(null); setKnowledgeFile(file); }} /></label>
                  <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-secondary/10 p-4 opacity-60"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground"><Globe2 className="h-4 w-4" /></div><div><p className="text-sm font-medium text-foreground">Website crawling</p><p className="mt-1 text-xs text-muted-foreground">Unavailable</p></div><span className="ml-auto rounded-full border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Unavailable</span></div>
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
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Purpose</dt><dd className="text-foreground sm:max-w-[70%] sm:text-right">{purpose}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Knowledge</dt><dd className="font-medium text-foreground sm:max-w-[70%] sm:text-right">{knowledgeText.trim() && knowledgeFile ? `Pasted information + ${knowledgeFile.name}` : knowledgeText.trim() ? "Pasted information" : knowledgeFile ? knowledgeFile.name : "None yet"}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Behavior</dt><dd className="font-medium capitalize text-foreground sm:text-right">{tone}, {responseDetail}</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Access</dt><dd className="font-medium text-foreground sm:text-right">No tools selected</dd></div>
                    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium text-foreground sm:text-right">Standard assistant runtime</dd></div>
                  </dl>
                </> : null}
              </div>

              {error ? <p className="mt-6 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
              <div className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-6"><Button type="button" variant="outline" disabled={loading} onClick={() => setStep((current) => current === 1 ? 1 : (current - 1) as Step)}>{step === 1 ? "Cancel" : <><ChevronLeft className="mr-1 h-4 w-4" />Back</>}</Button>{step < 4 ? <Button type="button" disabled={!canContinue} onClick={() => setStep((current) => (current + 1) as Step)}>Continue <ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button type="button" disabled={loading} onClick={() => void create()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating…</> : "Create agent"}</Button>}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
