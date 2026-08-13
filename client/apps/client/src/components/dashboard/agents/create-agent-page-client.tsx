"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Bot, CheckCircle2, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { createAgent, createAgentInstallation, createAgentVersion, publishAgentVersion } from "@/lib/agent-platform";

const starterInstructions = "You are a helpful KasiTek workspace agent. Use only the capabilities granted to this installation. Be clear about what you know, what you did, and what still requires the user to act.";

export function CreateAgentPageClient() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(starterInstructions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  const submit = async () => {
    if (!name.trim() || !instructions.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const agent = await createAgent({ name: name.trim(), slug: slug.trim() || undefined, description: description.trim() || undefined });
      const version = await createAgentVersion(agent.id, { instructions: instructions.trim(), configuration: {}, policy: {} });
      const published = await publishAgentVersion(agent.id, version.id);
      await createAgentInstallation(published.id, { tone: "balanced", responseDetail: "standard" });
      setCreated({ id: agent.id, name: agent.name });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create agent");
    } finally {
      setLoading(false);
    }
  };

  if (created) return <div className="min-h-screen p-6 lg:p-8"><div className="mx-auto max-w-2xl"><Card><CardContent className="p-8 text-center"><CheckCircle2 className="mx-auto h-10 w-10 text-accent" /><h1 className="mt-4 text-2xl font-semibold text-foreground">{created.name} is ready</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">The first version is published and installed for this workspace. Grant capabilities and run a test from the agent details view.</p><div className="mt-6 flex justify-center gap-2"><Button type="button" variant="outline" onClick={() => router.push("/agents")}>All agents</Button><Button asChild type="button"><Link href={`/agents/${encodeURIComponent(created.id)}`}>Open agent</Link></Button></div></CardContent></Card></div></div>;

  return <div className="min-h-screen p-6 lg:p-8"><div className="mx-auto max-w-3xl space-y-6"><Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link><header><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p><h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Create a hosted agent</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Create a versioned workspace agent with explicit instructions. It will start with no capability grants; choose those from its details page before testing.</p></header><Card><CardContent className="space-y-5 p-6"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary"><Bot className="h-5 w-5" /></span><div><h2 className="font-semibold text-foreground">Agent identity</h2><p className="mt-1 text-sm text-muted-foreground">Names and descriptions are visible to workspace members.</p></div></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-foreground">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Support assistant" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-sm font-medium text-foreground">Slug <span className="font-normal text-muted-foreground">(optional)</span><input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="support-assistant" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label></div><label className="block text-sm font-medium text-foreground">Description <span className="font-normal text-muted-foreground">(optional)</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} placeholder="What this agent helps with" className="mt-2 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="block text-sm font-medium text-foreground">Instructions<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={8} maxLength={200000} className="mt-2 block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm leading-6" /></label>{error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}<div className="flex justify-end"><Button type="button" disabled={loading || !name.trim() || !instructions.trim()} onClick={() => void submit()}>{loading ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Creating agent…</> : "Create and publish"}</Button></div></CardContent></Card></div></div>;
}
