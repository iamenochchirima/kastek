"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  deployAgentInstallation,
  getAgentDeploymentStatus,
  listAgentVersions,
  preflightAgentInstallationDeployment,
  promoteAgentInstallation,
  publishAgentVersion,
  rollbackAgentInstallation,
  type AgentDefinition,
  type AgentDeploymentPreflight,
  type AgentDeploymentStatus,
  type AgentVersion,
} from "@/lib/agent-platform";

type AgentDeploymentLifecycleProps = {
  agent: AgentDefinition;
  versions: AgentVersion[];
  selectedVersionId?: string | null;
  onVersionsChange?: (versions: AgentVersion[]) => void;
  onStatusChange?: (status: AgentDeploymentStatus | null) => void;
  compact?: boolean;
};

function deploymentLabel(status: AgentDeploymentStatus | null, loading: boolean): string {
  if (loading) return "Checking";
  if (!status) return "Unavailable";
  if (status.state === "pending") return "Pending";
  if (status.state === "blocked") return "Blocked";
  if (status.state === "rollback_available") return "Rollback available";
  return "Live";
}

function deploymentBadge(status: AgentDeploymentStatus | null, loading: boolean): string {
  if (loading || !status) return "border-border bg-secondary text-muted-foreground";
  if (status.state === "blocked") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  if (status.state === "pending") return "border-primary/30 bg-primary/10 text-primary";
  if (status.state === "rollback_available") return "border-status-info/30 bg-status-info-soft text-status-info";
  return "border-status-success/30 bg-status-success-soft text-status-success";
}

function versionLabel(version: AgentDeploymentStatus["playground"]["version"] | null): string {
  return version ? `v${version.versionNumber}` : "None";
}

export function AgentDeploymentLifecycle({
  agent,
  versions,
  selectedVersionId,
  onVersionsChange,
  onStatusChange,
  compact = false,
}: AgentDeploymentLifecycleProps) {
  const [status, setStatus] = useState<AgentDeploymentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"playground" | "preflight" | "promote" | "rollback" | null>(null);
  const [preflight, setPreflight] = useState<AgentDeploymentPreflight | null>(null);
  const [promotionOpen, setPromotionOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [candidateVersionId, setCandidateVersionId] = useState(selectedVersionId ?? versions[0]?.id ?? "");

  useEffect(() => {
    setCandidateVersionId((current) => {
      if (selectedVersionId) return selectedVersionId;
      if (current && versions.some((version) => version.id === current)) return current;
      return versions[0]?.id ?? "";
    });
  }, [selectedVersionId, versions]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === candidateVersionId) ?? versions[0] ?? null,
    [candidateVersionId, versions],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getAgentDeploymentStatus(agent.id);
      setStatus(next);
      onStatusChange?.(next);
      return next;
    } catch (cause) {
      setStatus(null);
      onStatusChange?.(null);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [agent.id, onStatusChange]);

  useEffect(() => {
    void refresh().catch((cause) => toast.error(cause instanceof Error ? cause.message : "Unable to load deployment status"));
  }, [candidateVersionId, refresh]);

  const publishCandidate = useCallback(async (version: AgentVersion): Promise<AgentVersion> => {
    if (version.status !== "draft") return version;
    const published = await publishAgentVersion(agent.id, version.id);
    const refreshed = await listAgentVersions(agent.id).catch(() => null);
    onVersionsChange?.(refreshed?.versions ?? versions.map((entry) => entry.id === published.id ? published : entry));
    return published;
  }, [agent.id, onVersionsChange, versions]);

  const updatePlayground = async () => {
    if (!selectedVersion || busy) return;
    setBusy("playground");
    try {
      const candidate = await publishCandidate(selectedVersion);
      const latest = await refresh();
      const sourceInstallationId = latest?.playground.installationId;
      if (!sourceInstallationId) throw new Error("Playground is not available for this agent");
      const currentVersionId = latest.playground.version?.versionId;
      if (currentVersionId !== candidate.id) {
        await deployAgentInstallation(sourceInstallationId, candidate.id, currentVersionId ?? undefined);
      }
      await refresh();
      toast.success("Playground updated");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to update Playground");
    } finally {
      setBusy(null);
    }
  };

  const preparePromotion = async () => {
    if (!selectedVersion || busy) return;
    setBusy("preflight");
    try {
      const candidate = await publishCandidate(selectedVersion);
      let latest = await refresh();
      const sourceInstallationId = latest?.playground.installationId;
      if (!sourceInstallationId) throw new Error("Playground is not available for this agent");
      if (latest.playground.version?.versionId !== candidate.id) {
        await deployAgentInstallation(sourceInstallationId, candidate.id, latest.playground.version?.versionId ?? undefined);
        latest = await refresh();
      }
      const liveInstallationId = latest?.live.installationId;
      const expectedVersionId = latest?.live.version?.versionId;
      if (!liveInstallationId || !expectedVersionId) throw new Error("Live is not ready for promotion");
      const nextPreflight = await preflightAgentInstallationDeployment(liveInstallationId, {
        versionId: candidate.id,
        sourceInstallationId,
        expectedVersionId,
      });
      setPreflight(nextPreflight);
      setPromotionOpen(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to prepare Live promotion");
    } finally {
      setBusy(null);
    }
  };

  const promote = async () => {
    if (!preflight?.ready || !status?.live.installationId || !preflight.current?.versionId || !preflight.sourceInstallationId || busy) return;
    setBusy("promote");
    try {
      await promoteAgentInstallation(status.live.installationId, {
        versionId: preflight.candidate?.versionId ?? "",
        sourceInstallationId: preflight.sourceInstallationId,
        expectedVersionId: preflight.current.versionId,
        idempotencyKey: crypto.randomUUID(),
      });
      setPromotionOpen(false);
      await refresh();
      toast.success("Live updated");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to promote to Live");
    } finally {
      setBusy(null);
    }
  };

  const rollback = async () => {
    if (!status?.live.installationId || !status.live.version?.versionId || busy) return;
    setBusy("rollback");
    try {
      await rollbackAgentInstallation(status.live.installationId, {
        expectedVersionId: status.live.version.versionId,
        targetVersionId: status.rollbackTarget?.versionId ?? undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      setRollbackOpen(false);
      await refresh();
      toast.success("Live rolled back");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to roll back Live");
    } finally {
      setBusy(null);
    }
  };

  const candidateDiffers = Boolean(status && selectedVersion && selectedVersion.id !== status.live.version?.versionId);
  const canPromote = Boolean(status?.live.installationId && candidateDiffers && selectedVersion);
  const canRollback = Boolean(status?.rollbackTarget && status.live.installationId);

  const compactControls = <div className="flex items-center gap-2">
    {candidateDiffers ? <span className="text-[11px] text-muted-foreground">Changes</span> : null}
    <Button
      type="button"
      size="sm"
      variant={candidateDiffers ? "default" : "outline"}
      className={!candidateDiffers ? "border-border/70 bg-muted/40 text-muted-foreground" : undefined}
      onClick={() => void preparePromotion()}
      disabled={!candidateDiffers || !status?.live.installationId || loading || busy !== null}
      aria-label={candidateDiffers ? "Deploy changes" : "Deployed"}
    >
      {busy === "preflight" ? "Deploying…" : candidateDiffers ? "Deploy" : "Deployed"}
    </Button>
  </div>;

  const controls = <div className="flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" onClick={() => void updatePlayground()} disabled={!selectedVersion || busy !== null}>
      <Rocket className="mr-1.5 size-3.5" />{busy === "playground" ? "Updating…" : "Update Playground"}
    </Button>
    {canPromote ? <Button type="button" size="sm" onClick={() => void preparePromotion()} disabled={busy !== null || loading}>
      <Rocket className="mr-1.5 size-3.5" />{busy === "preflight" ? "Checking…" : "Deploy to Live"}
    </Button> : null}
    {canRollback ? <Button type="button" variant="outline" size="sm" onClick={() => setRollbackOpen(true)} disabled={busy !== null}>
      <ArrowLeft className="mr-1.5 size-3.5" />Rollback Live
    </Button> : null}
    <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading || busy !== null} aria-label="Refresh deployment status">
      <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
    </Button>
  </div>;

  const summary = <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <Badge className={deploymentBadge(status, loading)}>{deploymentLabel(status, loading)}</Badge>
    <span>Playground {versionLabel(status?.playground.version ?? null)}</span>
    <span>Live {versionLabel(status?.live.version ?? null)}</span>
  </div>;

  return <>
    {compact ? <div className="flex items-center justify-end">{compactControls}</div> : <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Deployment</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Playground to Live</h2>
            <p className="mt-1 text-sm text-muted-foreground">Publish a candidate, test it in Playground, then activate the exact version in Live.</p>
          </div>
          {summary}
        </div>
        {versions.length ? <label className="block max-w-xs text-xs font-medium text-muted-foreground">Candidate version<select value={candidateVersionId} onChange={(event) => setCandidateVersionId(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-medium text-foreground outline-none focus:border-primary">{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {version.status}</option>)}</select></label> : null}
        {status?.state === "blocked" ? <p className="rounded-lg border border-status-attention/30 bg-status-attention-soft px-3 py-2 text-xs text-status-attention">Live or Playground is not ready for promotion.</p> : null}
        {controls}
      </CardContent>
    </Card>}
    <Dialog open={promotionOpen} onOpenChange={(open) => { if (!busy) setPromotionOpen(open); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Deploy to Live</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"><span className="text-muted-foreground">Preflight</span><span className={preflight?.ready ? "font-medium text-status-success" : "font-medium text-status-attention"}>{preflight?.status ?? "Checking"}</span></div>
          {preflight?.candidate ? <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Candidate</span><span className="font-medium text-foreground">v{preflight.candidate.versionNumber}</span></div> : null}
          {preflight?.current ? <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Current Live</span><span className="font-medium text-foreground">v{preflight.current.versionNumber}</span></div> : null}
          {preflight?.blockers.length ? <ul className="space-y-1 rounded-lg border border-status-attention/30 bg-status-attention-soft p-3 text-xs text-status-attention">{preflight.blockers.map((blocker) => <li key={`${blocker.code}:${blocker.detail}`}>{blocker.detail}</li>)}</ul> : <p className="text-xs text-muted-foreground">Only the tested immutable Playground candidate will become Live.</p>}
        </div>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setPromotionOpen(false)} disabled={busy !== null}>Cancel</Button><Button type="button" onClick={() => void promote()} disabled={busy !== null || !preflight?.ready}>{busy === "promote" ? "Deploying…" : "Deploy to Live"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={rollbackOpen} onOpenChange={(open) => { if (!busy) setRollbackOpen(open); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Rollback Live?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Restore the previous tested Live version. Playground, conversations, memories, and active runs remain unchanged.</p>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setRollbackOpen(false)} disabled={busy !== null}>Cancel</Button><Button type="button" variant="destructive" onClick={() => void rollback()} disabled={busy !== null}>{busy === "rollback" ? "Rolling back…" : "Rollback Live"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
