"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, ArrowLeft, CheckCircle2, History, RotateCcw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  archiveAgent,
  publishAgentVersion,
  rollbackAgentVersion,
  retireAgentVersion,
  updateAgentInstallationSettings,
  type AgentDefinition,
  type AgentVersion,
} from "@/lib/agent-platform";

function versionStatusClass(status: string) {
  if (status === "published") return "border-accent/30 bg-accent/10 text-accent";
  if (status === "draft") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-border bg-secondary text-muted-foreground";
}

export function AgentDetailPageClient({ agent, initialVersions }: { agent: AgentDefinition; initialVersions: AgentVersion[] }) {
  const router = useRouter();
  const [versions, setVersions] = useState(initialVersions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tone, setTone] = useState(String(agent.installation_settings?.tone ?? "balanced"));
  const [responseDetail, setResponseDetail] = useState(String(agent.installation_settings?.responseDetail ?? "standard"));
  const [savingSettings, setSavingSettings] = useState(false);
  const protectedAgent = agent.protected;

  const mutate = async (action: string, operation: () => Promise<unknown>) => {
    setBusy(action);
    setError(null);
    try {
      await operation();
      router.refresh();
      setVersions((current) => current.map((version) => {
        if (action === `publish:${version.id}` || action === `rollback:${version.id}`) return { ...version, status: "published", published_at: new Date().toISOString() };
        if (action === `retire:${version.id}`) return { ...version, status: "retired", retired_at: new Date().toISOString() };
        return action === "archive" ? current[0] ?? version : version;
      }));
      if (action === "archive") router.push("/agents");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent operation failed");
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    if (!agent.installation_id) return;
    setSavingSettings(true);
    setError(null);
    try {
      await updateAgentInstallationSettings(agent.installation_id, { tone: tone as "concise" | "balanced" | "detailed", responseDetail: responseDetail as "concise" | "standard" | "detailed" });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save agent settings");
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1100px] space-y-6">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
        <Card>
          <CardContent className="space-y-5 p-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div className="flex items-start gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">{protectedAgent ? <Sparkles className="h-5 w-5" /> : <History className="h-5 w-5" />}</div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agent details</p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{agent.name}</h1>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{agent.description || "Installed Agent Platform agent"}</p>
                </div>
              </div>
              {protectedAgent ? <Badge className="w-fit border-primary/20 bg-primary/10 text-primary">Protected system agent</Badge> : <Button type="button" variant="outline" disabled={busy === "archive"} onClick={() => void mutate("archive", () => archiveAgent(agent.id))}><Archive className="mr-2 h-4 w-4" />{busy === "archive" ? "Archiving…" : "Archive agent"}</Button>}
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Slug</p><p className="mt-1 font-medium text-foreground">{agent.slug}</p></div>
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Installation</p><p className="mt-1 font-medium capitalize text-foreground">{agent.installation_status ?? "not installed"}</p></div>
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Current version</p><p className="mt-1 font-medium text-foreground">{agent.version_number ? `v${agent.version_number}` : "None published"}</p></div>
            </div>
            {protectedAgent ? <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">KasiAi instructions, model policy, and version publishing are controlled by KasiTek releases. Workspace members can use and pause its installation, but cannot mutate the protected definition.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-6">
            <div><h2 className="text-lg font-semibold text-foreground">Workspace preferences</h2><p className="mt-1 text-sm text-muted-foreground">These settings affect this workspace installation only. Protected instructions and tool policy remain unchanged.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-foreground">Response tone<select value={tone} onChange={(event) => setTone(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
              <label className="text-sm font-medium text-foreground">Response detail<select value={responseDetail} onChange={(event) => setResponseDetail(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="concise">Concise</option><option value="standard">Standard</option><option value="detailed">Detailed</option></select></label>
            </div>
            <Button type="button" onClick={() => void saveSettings()} disabled={!agent.installation_id || savingSettings}>{savingSettings ? "Saving…" : "Save preferences"}</Button>
          </CardContent>
        </Card>

        <section className="space-y-3" aria-labelledby="agent-versions-title">
          <div><h2 id="agent-versions-title" className="text-lg font-semibold text-foreground">Version history</h2><p className="text-sm text-muted-foreground">Published versions are immutable. Drafts can be published; retired versions can be rolled back.</p></div>
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          {!versions.length ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No versions are available for this agent.</CardContent></Card> : versions.map((version) => (
            <Card key={version.id}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex items-center gap-2"><h3 className="font-semibold text-foreground">Version {version.version_number}</h3><Badge className={versionStatusClass(version.status)}>{version.status}</Badge>{version.status === "published" ? <CheckCircle2 className="h-4 w-4 text-accent" aria-label="Published" /> : null}</div><p className="mt-1 text-xs text-muted-foreground">Created {new Date(version.created_at).toLocaleString()}{version.published_at ? ` · Published ${new Date(version.published_at).toLocaleString()}` : ""}</p></div>
              {!protectedAgent ? <div className="flex flex-wrap gap-2">
                {version.status === "draft" ? <Button type="button" size="sm" disabled={busy !== null} onClick={() => void mutate(`publish:${version.id}`, () => publishAgentVersion(agent.id, version.id))}>Publish</Button> : null}
                {version.status === "retired" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void mutate(`rollback:${version.id}`, () => rollbackAgentVersion(agent.id, version.id))}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Rollback</Button> : null}
                {version.status === "published" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void mutate(`retire:${version.id}`, () => retireAgentVersion(agent.id, version.id))}>Retire</Button> : null}
              </div> : null}
            </CardContent></Card>
          ))}
        </section>
      </div>
    </div>
  );
}
