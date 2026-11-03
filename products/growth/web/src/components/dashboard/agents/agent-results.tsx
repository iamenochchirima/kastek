import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { AgentResultFiles } from "@kasitek-labs/ui/agent";
import { ArrowUpRight } from "@/components/ui/interface-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { growthAgents, safeGrowthRoute, type GrowthAgentArtifact, type GrowthAgentTask } from "@/lib/growth-agents";

export function TaskResults({ task, rootTaskId = task.id, childTaskId }: { task: GrowthAgentTask; rootTaskId?: string; childTaskId?: string }) {
  const [artifact, setArtifact] = useState<GrowthAgentArtifact | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const openArtifact = async (id: string) => {
    if (controller.current) return;
    setBusy(id);setError(null);
    const abort = new AbortController();controller.current = abort;
    try {
      const result = await growthAgents.artifact(rootTaskId, id, abort.signal, childTaskId);
      if (result.artifact.id !== id) throw new Error("Result unavailable");
      if (!abort.signal.aborted) setArtifact(result.artifact);
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to open this result."); }
    finally { if (controller.current === abort) { controller.current = null;if (!abort.signal.aborted) setBusy(null); } }
  };
  const fileResults = (task.results ?? []).filter(result => result.artifactId && !safeGrowthRoute(result.route));
  const otherResults = (task.results ?? []).filter(result => !result.artifactId || safeGrowthRoute(result.route));
  const suppliedDownload = safeGrowthRoute(artifact?.downloadPath);
  const expectedPath = artifact ? `/api/agents/tasks/${encodeURIComponent(rootTaskId)}/artifacts/${encodeURIComponent(artifact.id)}/download` : "";
  const safeDownload = suppliedDownload && new URL(suppliedDownload, "https://growth.invalid").pathname === expectedPath;
  const download = safeDownload ? `${expectedPath}${childTaskId ? `?${new URLSearchParams({ childTaskId })}` : ""}` : null;
  return <>
    {otherResults.length ? <div className="flex flex-wrap gap-2">{otherResults.map(result => {
      const route = safeGrowthRoute(result.route);
      return route ? <Link key={result.id} to={route} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-secondary"><span className="truncate">{result.title}</span><ArrowUpRight className="size-3.5 shrink-0" /></Link> : <span key={result.id} className="text-xs text-muted-foreground">{result.title}</span>;
    })}</div> : null}
    <AgentResultFiles files={fileResults.map(result => ({ id: result.artifactId!, title: result.title }))} busyId={busy} error={error} onSelect={file => void openArtifact(file.id)} />
    <Dialog open={Boolean(artifact)} onOpenChange={open => { if (!open) setArtifact(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{artifact?.title}</DialogTitle><DialogDescription className="sr-only">Agent result</DialogDescription></DialogHeader><div className="min-w-0 whitespace-pre-wrap break-words text-sm">{artifact?.text || "No preview available."}</div>{download ? <div className="flex justify-end"><Button asChild size="sm"><a href={download} download>Download</a></Button></div> : null}</DialogContent></Dialog>
  </>;
}
