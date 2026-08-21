"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import {
  createAgentVersion,
  publishAgentVersion,
  sendPlatformMessage,
  type AgentDefinition,
  type AgentVersion,
} from "@/lib/agent-platform";
import { AgentWorkflowEditor, type WorkflowGraphValue } from "./agent-workflow-editor";

function versionLabel(version: AgentVersion | undefined): string {
  return version ? `v${version.version_number}` : "No version";
}

export function AgentWorkflowPageClient({ agent, initialVersions }: { agent: AgentDefinition; initialVersions: AgentVersion[] }) {
  const baseVersion = initialVersions.find((version) => version.status === "draft")
    ?? initialVersions.find((version) => version.status === "published")
    ?? initialVersions[0];
  const baseConfiguration = baseVersion?.configuration ?? {};
  const [workflow, setWorkflow] = useState<WorkflowGraphValue | null>(null);
  const [workflowValid, setWorkflowValid] = useState(true);
  const [workflowReady, setWorkflowReady] = useState(false);
  const [draftVersion, setDraftVersion] = useState<AgentVersion | null>(baseVersion?.status === "draft" ? baseVersion : null);
  const [publishedVersion, setPublishedVersion] = useState<AgentVersion | undefined>(initialVersions.find((version) => version.status === "published"));
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onWorkflowChange = useCallback((next: WorkflowGraphValue | null) => {
    setWorkflow(next);
    setWorkflowReady(true);
  }, []);

  const onWorkflowValidity = useCallback((valid: boolean) => {
    setWorkflowValid(valid);
    setWorkflowReady(true);
  }, []);

  const saveDraft = async (): Promise<AgentVersion | null> => {
    if (!workflow || !workflowValid || busy) return null;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const created = await createAgentVersion(agent.id, {
        instructions: baseVersion?.instructions?.trim() || `You are ${agent.name}, a user-configured agent. Follow the workflow and respond using only the available context and connected tools.`,
        configuration: { ...baseConfiguration, workflow },
        policy: baseVersion?.policy ?? {},
      });
      setDraftVersion(created);
      setNotice(`Draft ${versionLabel(created)} saved. Publish it when you are ready.`);
      return created;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the workflow draft.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (busy) return;
    // Always snapshot the current canvas before publishing. This prevents an
    // older saved draft from being published after the user edits the graph.
    const version = await saveDraft();
    if (!version) return;
    setBusy("publish");
    setError(null);
    setNotice(null);
    try {
      const published = await publishAgentVersion(agent.id, version.id);
      setPublishedVersion(published);
      setDraftVersion(null);
      setNotice(`${versionLabel(published)} is now live.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to publish the workflow.");
    } finally {
      setBusy(null);
    }
  };

  const runWorkflowTest = async (message: string) => {
    if (!agent.installation_id || agent.installation_status !== "active") throw new Error("Resume the installation before testing the workflow.");
    return sendPlatformMessage(agent.installation_id, {
      message,
      idempotencyKey: crypto.randomUUID(),
      createNew: true,
      context: { route: window.location.pathname, pageTitle: `${agent.name} workflow test` },
    });
  };

  return <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1240px]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link href={`/agents/${encodeURIComponent(agent.id)}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agent</Link>
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="rounded-full border border-border bg-secondary px-2.5 py-1">Live {versionLabel(publishedVersion)}</span>{draftVersion ? <span className="rounded-full border border-status-attention/30 bg-status-attention-soft px-2.5 py-1 text-status-attention">Draft {versionLabel(draftVersion)}</span> : null}</div>
      </div>
      <Card className="mt-5 border-border/80 shadow-sm"><CardContent className="space-y-4 p-5 sm:p-7">
        <PageHeader><PageHeaderContent><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Workflow editor</p><PageHeaderTitle>{agent.name}</PageHeaderTitle><PageHeaderDescription>Configure steps, then save and publish a version.</PageHeaderDescription></PageHeaderContent><PageHeaderActions><Button type="button" variant="outline" disabled={busy !== null || !workflowReady || !workflowValid || !workflow} onClick={() => void saveDraft()}>{busy === "save" ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save draft"}</Button><Button type="button" disabled={busy !== null || !workflowReady || !workflowValid || !workflow} onClick={() => void publish()}>{busy === "publish" ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Publishing…</> : "Publish"}</Button></PageHeaderActions></PageHeader>
        {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        {notice ? <p className="flex items-center gap-2 rounded-lg border border-status-success/30 bg-status-success-soft px-3 py-2 text-sm text-status-success" role="status"><CheckCircle2 className="h-4 w-4" />{notice}</p> : null}
      </CardContent></Card>
      <div className="mt-6"><AgentWorkflowEditor configuration={baseConfiguration} onChange={onWorkflowChange} onValidityChange={onWorkflowValidity} onTestRun={agent.installation_id && agent.installation_status === "active" ? runWorkflowTest : undefined} /></div>
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><Upload className="h-3.5 w-3.5" />The canvas is the workflow. Configure each node by selecting it, then save a draft before publishing.</p>
    </div>
  </div>;
}
