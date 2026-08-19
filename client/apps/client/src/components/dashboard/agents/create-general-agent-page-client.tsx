"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Bot, CheckCircle2, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { createAgent, createAgentInstallation, createAgentVersion, publishAgentVersion } from "@/lib/agent-platform";

type Step = 1 | 2 | 3;

const model = { provider: "openrouter", name: "openai/gpt-oss-20b:free" };
const generalCapabilities = [
  "platform.current_time",
  "kasitek.core.workspace_status",
  "kasitek.core.workspace_report",
  "kasitek.core.customer_get",
  "kasitek.core.booking_services_list",
  "kasitek.core.bookings_list",
  "kasitek.core.booking_get",
  "kasitek.core.campaigns_list",
  "kasitek.core.campaign_summary",
  "kasitek.core.templates_list",
  "kasitek.core.contacts_list",
  "kasitek.core.inbox_conversations_list",
  "kasitek.core.inbox_messages_list",
  "kasitek.core.content_posts_list",
  "kasitek.core.content_post_get",
];

export function CreateGeneralAgentPageClient() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tone, setTone] = useState("balanced");
  const [responseDetail, setResponseDetail] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  const canContinue = step === 1 ? name.trim().length > 0 && purpose.trim().length > 0 : true;

  const create = async () => {
    if (!name.trim() || !purpose.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const agent = await createAgent({ name: name.trim(), description: purpose.trim(), creationProfile: "general" });
      const maxTotalTokens = 2_048;
      const version = await createAgentVersion(agent.id, {
        instructions: [
          "You are a general-purpose KasiTek workspace assistant.",
          `Your primary purpose is: ${purpose.trim()}`,
          `Use a ${tone} tone and provide ${responseDetail} responses.`,
          "Use only the capabilities granted to this installation. Never claim an action was completed without a trusted result, and clearly explain when a request needs the user to act.",
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
          allowedTools: generalCapabilities,
          modelPolicy: { version: "hosted-agent-v1", primary: model, fallback: [], allowUserFundedFallbackToKasiTek: false, maxTokensPerRun: maxTotalTokens },
          runLimits: { maxIterations: 6, maxToolCalls: 6, maxModelCalls: 6, maxTotalTokens, maxContextMessages: 24, maxContextTokens: 8_000, maxWallTimeMs: 60_000 },
        },
      });
      const published = await publishAgentVersion(agent.id, version.id);
      await createAgentInstallation(published.id, { profile: "general", tone, responseDetail });
      setCreated({ id: agent.id, name: agent.name });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the general-purpose agent");
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <div className="min-h-screen p-6 lg:p-8">
        <div className="mx-auto max-w-2xl">
          <Card><CardContent className="p-8 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-accent" />
            <h1 className="mt-4 text-2xl font-semibold text-foreground">{created.name} is ready</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Your general-purpose agent is installed for this workspace. Add knowledge, capabilities, and channels from its details page when you are ready.</p>
            <div className="mt-6 flex justify-center gap-2"><Button type="button" variant="outline" onClick={() => router.push("/agents")}>All agents</Button><Button asChild><Link href={`/agents/${encodeURIComponent(created.id)}`}>Open agent</Link></Button></div>
          </CardContent></Card>
        </div>
      </div>
    );
  }

  const steps = [[1, "Basics"], [2, "Behavior"], [3, "Review"]] as const;
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
        <header><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">General-purpose agent</p><h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Create a simple agent</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Start with a useful assistant in a few steps. Technical workflow and model settings stay out of the way.</p></header>
        <nav aria-label="Creation progress" className="grid grid-cols-3 gap-2">
          {steps.map(([number, label]) => <div key={number} className={`rounded-lg border px-3 py-2 text-center text-xs ${step === number ? "border-primary bg-primary/10 text-primary" : step > number ? "border-accent/30 bg-accent/10 text-accent" : "border-border text-muted-foreground"}`}><span className="font-semibold">{number}. </span>{label}</div>)}
        </nav>

        <Card><CardContent className="space-y-5 p-6">
          {step === 1 ? <>
            <div><h2 className="text-xl font-semibold text-foreground">What should we call it?</h2><p className="mt-1 text-sm text-muted-foreground">This name is visible wherever the agent is used.</p></div>
            <label className="block text-sm font-medium text-foreground">Agent name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="My assistant" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
            <label className="block text-sm font-medium text-foreground">What should it help with?<textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={4} maxLength={2000} placeholder="Help my team answer customer questions and find the right next step." className="mt-2 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
          </> : null}
          {step === 2 ? <>
            <div><h2 className="text-xl font-semibold text-foreground">How should it respond?</h2><p className="mt-1 text-sm text-muted-foreground">You can change these choices later from the agent details page.</p></div>
            <label className="block text-sm font-medium text-foreground">Tone<select value={tone} onChange={(event) => setTone(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="concise">Concise and direct</option><option value="balanced">Balanced</option><option value="warm">Warm and conversational</option><option value="detailed">Detailed and explanatory</option></select></label>
            <label className="block text-sm font-medium text-foreground">Response detail<select value={responseDetail} onChange={(event) => setResponseDetail(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="short">Short answers</option><option value="standard">Standard answers</option><option value="thorough">Thorough answers</option></select></label>
            <div className="rounded-lg bg-secondary/40 p-3 text-sm text-muted-foreground"><Bot className="mr-2 inline h-4 w-4 text-primary" />Knowledge sources, capabilities, channels, and advanced settings can be added after the agent is created.</div>
          </> : null}
          {step === 3 ? <>
            <div><h2 className="text-xl font-semibold text-foreground">Review your agent</h2><p className="mt-1 text-sm text-muted-foreground">This creates a standard general-purpose agent with safe runtime defaults.</p></div>
            <dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm"><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Name</dt><dd className="font-medium text-foreground">{name}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Purpose</dt><dd className="max-w-[65%] text-right text-foreground">{purpose}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Behavior</dt><dd className="font-medium capitalize text-foreground">{tone}, {responseDetail}</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Access</dt><dd className="max-w-[65%] text-right font-medium text-foreground">Read-only workspace context ({generalCapabilities.length} capabilities)</dd></div><div className="flex justify-between gap-4 p-3"><dt className="text-muted-foreground">Workflow</dt><dd className="font-medium text-foreground">Standard assistant runtime</dd></div></dl>
          </> : null}
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          <div className="flex justify-between gap-2"><Button type="button" variant="outline" disabled={loading} onClick={() => setStep((current) => current === 1 ? 1 : (current - 1) as Step)}>{step === 1 ? "Cancel" : <><ChevronLeft className="mr-1 h-4 w-4" />Back</>}</Button>{step < 3 ? <Button type="button" disabled={!canContinue} onClick={() => setStep((current) => (current + 1) as Step)}>Continue <ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button type="button" disabled={loading} onClick={() => void create()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating…</> : "Create agent"}</Button>}</div>
        </CardContent></Card>
      </div>
    </div>
  );
}
